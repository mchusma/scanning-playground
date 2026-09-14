import Combine
import CoreLocation
import Foundation

/// Where on Earth the AR origin is, and whether the AR axes were compass-aligned.
/// With heading alignment ARKit puts +X toward east and −Z toward north, so
/// plan.x = east and plan.y (= world z) = south. Compass error indoors is
/// several degrees; the measured wall grid corrects it, the compass only
/// decides which of four orientations the plan has.
struct GeoRecord: Codable, Equatable {
    var latitude: Double
    var longitude: Double
    var horizontalAccuracy: Double
    var altitude: Double?
    var headingAligned: Bool
    var trueHeading: Double?
    var magneticHeading: Double?
    var headingAccuracy: Double?
    var capturedAt: TimeInterval
    /// Camera position on the plan when the fix was taken (plan metres).
    var cameraPlan: Vec2
    /// Original sensor time distinguishes a repeated fix from a fresh update.
    var locationTimestamp: TimeInterval?
    var headingTimestamp: TimeInterval?
}

/// The real building footprint from public map data, delivered by the Mac.
struct SiteRecord: Codable, Equatable {
    /// Footprint vertices in metres east/north of `centroid`.
    var footprintEastNorth: [Vec2]
    var centroidLatitude: Double
    var centroidLongitude: Double
    /// Dominant wall bearing, degrees clockwise from north, in [0, 90).
    var wallBearingDegrees: Double
    var areaSquareMeters: Double
    var source: String
    /// Footprint vertices in plan metres after placement (rotation snapped to the
    /// measured grid, translation from GPS then refined by containment). Nil until placed.
    var footprintPlan: [Vec2]?
    /// How the footprint was placed, for the HUD.
    var placementNote: String?
    var address: String?
    var widthEastWestMeters: Double?
    var depthNorthSouthMeters: Double?
    var aerialPath: String?
    var propertyFacts: PropertyFacts?
}

struct PropertyFacts: Codable, Equatable {
    var bedrooms: Double?
    var bathrooms: Double?
    var livingAreaSqFt: Double?
    var storeys: Double?
    var propertyType: String?
    var roomsMentioned: [String] = []
    var verified: Bool = false
}

/// One-shot location + heading, asked for on the permissions screen and read
/// at floor confirmation. Never runs in the background.
@MainActor
final class GeoProvider: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var authorization: CLAuthorizationStatus
    @Published private(set) var location: CLLocation?
    @Published private(set) var heading: CLHeading?

    private let manager = CLLocationManager()

    override init() {
        authorization = CLLocationManager().authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    var authorized: Bool {
        authorization == .authorizedWhenInUse || authorization == .authorizedAlways
    }

    nonisolated static var isAuthorized: Bool {
        let s = CLLocationManager().authorizationStatus
        return s == .authorizedWhenInUse || s == .authorizedAlways
    }

    func request() {
        if authorization == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else if authorized {
            start()
        }
    }

    func start() {
        guard authorized else { return }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.headingFilter = 1
            manager.startUpdatingHeading()
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    /// Snapshot for the document. `headingAligned` is what the AR session was started with.
    func record(headingAligned: Bool, cameraPlan: Vec2) -> GeoRecord? {
        guard let location, location.horizontalAccuracy >= 0 else { return nil }
        return GeoRecord(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            horizontalAccuracy: location.horizontalAccuracy,
            altitude: location.verticalAccuracy >= 0 ? location.altitude : nil,
            headingAligned: headingAligned,
            trueHeading: heading.map { $0.trueHeading >= 0 ? $0.trueHeading : nil } ?? nil,
            magneticHeading: heading?.magneticHeading,
            headingAccuracy: heading.map { $0.headingAccuracy >= 0 ? $0.headingAccuracy : nil } ?? nil,
            capturedAt: Date().timeIntervalSince1970,
            cameraPlan: cameraPlan,
            locationTimestamp: location.timestamp.timeIntervalSince1970,
            headingTimestamp: heading?.timestamp.timeIntervalSince1970
        )
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorization = status
            if self.authorized { self.start() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        Task { @MainActor in
            // Keep the best fix seen, not just the latest.
            if let current = self.location, current.horizontalAccuracy > 0, current.horizontalAccuracy <= last.horizontalAccuracy,
               last.timestamp.timeIntervalSince(current.timestamp) < 60 { return }
            self.location = last
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        Task { @MainActor in self.heading = newHeading }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

enum SitePlacement {
    /// Metres per degree at a latitude.
    static func metersPerDegree(latitude: Double) -> (lat: Double, lon: Double) {
        (111_320, 111_320 * cos(latitude * .pi / 180))
    }

    /// Place the footprint on the plan.
    ///
    /// Rotation: with heading alignment, north on the *unaligned* plan is (0, −1)
    /// (plan y is world z, which points south). After the plan has been rotated by
    /// `gridAngle`, north is that vector rotated by −gridAngle. The footprint's
    /// walls run `wallBearing` clockwise from north; snap that direction to the
    /// nearest plan axis so the outline shares the measured grid. The size of the
    /// snap is the compass error.
    ///
    /// Translation: the GPS fix says where the camera was relative to the
    /// footprint centroid; then, if any rooms exist, slide within ±`searchMeters`
    /// to maximise how much of the rooms lies inside the outline.
    static func place(site: SiteRecord, geo: GeoRecord, gridAngle: Double?, rooms: [[Vec2]], searchMeters: Double = 15) -> (plan: [Vec2], note: String) {
        let g = gridAngle ?? 0
        // North and east on the current plan.
        let north = Vec2(x: 0, y: -1).rotated(by: -g)
        let east = Vec2(x: 1, y: 0).rotated(by: -g)
        // Direction of a wall with bearing b (clockwise from north): sin(b)·east + cos(b)·north.
        let b = site.wallBearingDegrees * .pi / 180
        let wall = Vec2(x: east.x * sin(b) + north.x * cos(b), y: east.y * sin(b) + north.y * cos(b))
        let phi = atan2(wall.y, wall.x)
        let snapped = (phi / (.pi / 2)).rounded() * (.pi / 2)
        // Until a measured grid exists, retain the real compass orientation.
        // Snapping only the footprint at startup rotates it away from the path.
        let compassError = gridAngle == nil ? 0 : snapped - phi
        let toPlan: (Vec2) -> Vec2 = { en in
            let v = Vec2(x: east.x * en.x + north.x * en.y, y: east.y * en.x + north.y * en.y)
            return v.rotated(by: compassError)
        }
        let localPoly = site.footprintEastNorth.map(toPlan)

        // GPS: camera → centroid offset in east/north metres.
        let mpd = metersPerDegree(latitude: site.centroidLatitude)
        let dEast = (site.centroidLongitude - geo.longitude) * mpd.lon
        let dNorth = (site.centroidLatitude - geo.latitude) * mpd.lat
        // Apply the same geographic-to-plan transform to the polygon and GPS
        // offset: the camera fix is the pivot, not the building centroid.
        var centre = geo.cameraPlan + toPlan(Vec2(x: dEast, y: dNorth))
        var note = gridAngle == nil
            ? String(format: "initial compass alignment, GPS ±%.1f m", geo.horizontalAccuracy)
            : String(format: "compass snap %.0f°, GPS ±%.1f m", compassError * 180 / .pi, geo.horizontalAccuracy)

        // Containment refinement.
        if !rooms.isEmpty {
            let samples: [Vec2] = rooms.flatMap { poly -> [Vec2] in
                guard let bb = Geometry.bounds(poly) else { return [] }
                var pts: [Vec2] = []
                var x = bb.min.x + 0.2
                while x < bb.max.x { var y = bb.min.y + 0.2; while y < bb.max.y { pts.append(Vec2(x: x, y: y)); y += 0.4 }; x += 0.4 }
                return pts
            }
            func score(_ c: Vec2) -> Double {
                let poly = localPoly.map { $0 + c }
                var k = 0
                for p in samples where Geometry.pointInPolygon(p, poly) { k += 1 }
                return samples.isEmpty ? 0 : Double(k) / Double(samples.count)
            }
            var best = (score: score(centre), c: centre)
            var dx = -searchMeters
            while dx <= searchMeters {
                var dy = -searchMeters
                while dy <= searchMeters {
                    let c = centre + Vec2(x: dx, y: dy)
                    let s = score(c)
                    if s > best.score + 1e-9 || (abs(s - best.score) < 1e-9 && c.distance(to: centre) < best.c.distance(to: centre)) { best = (s, c) }
                    dy += 0.5
                }
                dx += 0.5
            }
            note += String(format: ", rooms inside %.0f%% after %.1f m nudge", best.score * 100, best.c.distance(to: centre))
            centre = best.c
        }
        return (localPoly.map { $0 + centre }, note)
    }
}
