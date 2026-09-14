import XCTest
@testable import HomeWalk

/// The footprint must land on the plan rotated to the measured wall grid (the
/// compass only picks the quadrant), positioned by GPS and then pulled onto the
/// walked rooms.
final class SitePlacementTests: XCTestCase {
    /// A 10 × 8 m rectangle whose long walls run at `bearing` degrees clockwise from north.
    private func site(bearing: Double, centroidLat: Double = 33.659, centroidLon: Double = -117.893) -> SiteRecord {
        let b = bearing * .pi / 180
        let along = Vec2(x: sin(b), y: cos(b))          // east, north
        let across = Vec2(x: cos(b), y: -sin(b))
        let corners = [(-5.0, -4.0), (5.0, -4.0), (5.0, 4.0), (-5.0, 4.0)].map { u, v in
            Vec2(x: along.x * u + across.x * v, y: along.y * u + across.y * v)
        }
        return SiteRecord(footprintEastNorth: corners, centroidLatitude: centroidLat, centroidLongitude: centroidLon, wallBearingDegrees: bearing, areaSquareMeters: 80, source: "test", footprintPlan: nil, placementNote: nil)
    }

    private func geo(lat: Double, lon: Double, accuracy: Double = 8, cameraPlan: Vec2 = .zero) -> GeoRecord {
        GeoRecord(latitude: lat, longitude: lon, horizontalAccuracy: accuracy, altitude: nil, headingAligned: true, trueHeading: nil, magneticHeading: nil, headingAccuracy: nil, capturedAt: 0, cameraPlan: cameraPlan)
    }

    private func size(_ poly: [Vec2]) -> (Double, Double) { let s = Geometry.size(of: poly)!; return (s.width, s.depth) }
    private func axisAligned(_ poly: [Vec2]) -> Bool {
        (0..<poly.count).allSatisfy { i in
            let a = poly[i], b = poly[(i + 1) % poly.count]
            return abs(a.x - b.x) < 1e-6 || abs(a.y - b.y) < 1e-6
        }
    }

    func testConfirmedPropertySnapshotAndLegacySiteDecode() throws {
        let original = site(bearing: 40)
        let legacy = try JSONEncoder().encode(original)
        let restored = try JSONDecoder().decode(SiteRecord.self, from: legacy)
        XCTAssertNil(restored.propertyFacts)
        XCTAssertNil(restored.address)
        var confirmed = original
        confirmed.address = "Sample home"
        confirmed.propertyFacts = PropertyFacts(bedrooms: 3, bathrooms: 2, livingAreaSqFt: 1500, roomsMentioned: ["Kitchen"])
        let session = CaptureSession(name: "Property", capabilities: .simulated)
        session.setSite(confirmed)
        let loaded = try CaptureSession.fromJSON(session.exportedJSON())
        XCTAssertEqual(loaded.site, confirmed)
        XCTAssertNil(loaded.site?.propertyFacts?.storeys, "unknown listing values stay unknown")
    }

    func testTrackingTransitionsAreTimestampedWithoutPerFrameDuplicates() {
        let session = CaptureSession(name: "Tracking", capabilities: .simulated)
        session.updateTracking(.normal)
        _ = session.beginWalk(SimulatedHit.downward(x: 0, z: 0))
        session.appendGeoSample(geo(lat: 30, lon: -100))
        XCTAssertEqual(session.document.geoSamples.count, 1)
        XCTAssertEqual(try? CaptureSession.fromJSON(session.exportedJSON()).document.geoSamples, session.document.geoSamples)
        session.updateTracking(.interrupted)
        session.updateTracking(.interrupted)
        session.updateTracking(.normal)
        let events = session.events.filter { $0.type == "trackingState" }
        XCTAssertEqual(events.count, 2)
        XCTAssertTrue(events.allSatisfy { $0.timestamp > 0 })
        XCTAssertNotEqual(events[0].detail, events[1].detail)
    }

    func testFootprintSnapsToMeasuredGridAndSitsAtGPSOffset() {
        // Walls at 40°. The measured grid (from yaw) says the plan must rotate by 40°,
        // which is exactly the wall angle as seen on a plan whose y axis points south.
        let s = site(bearing: 40)
        // Camera at the plan origin; footprint centroid 6 m east and 2 m north of it.
        let mpd = SitePlacement.metersPerDegree(latitude: s.centroidLatitude)
        let g = geo(lat: s.centroidLatitude - 2 / mpd.lat, lon: s.centroidLongitude - 6 / mpd.lon)
        let gridAngle = 40.0 * .pi / 180
        let placed = SitePlacement.place(site: s, geo: g, gridAngle: gridAngle, rooms: [])
        XCTAssertTrue(axisAligned(placed.plan), "footprint walls share the plan axes")
        let sz = size(placed.plan)
        XCTAssertEqual(min(sz.0, sz.1), 8, accuracy: 0.01)
        XCTAssertEqual(max(sz.0, sz.1), 10, accuracy: 0.01)
        // Centroid on the plan = camera + (6 m east, 2 m north) expressed in the rotated frame.
        let east = Vec2(x: 1, y: 0).rotated(by: -gridAngle), north = Vec2(x: 0, y: -1).rotated(by: -gridAngle)
        let expected = east * 6 + north * 2
        let c = placed.plan.reduce(Vec2.zero, +) * (1.0 / Double(placed.plan.count))
        XCTAssertEqual(c.x, expected.x, accuracy: 1e-6)
        XCTAssertEqual(c.y, expected.y, accuracy: 1e-6)
        XCTAssertTrue(placed.note.contains("compass snap 0°") || placed.note.contains("compass snap -0°"), placed.note)
        print("ASSERT: footprint is axis-aligned on the measured grid and offset by the GPS vector")
    }

    func testCompassErrorIsAbsorbedByTheSnap() {
        // Same house, but the compass was 9° off, so the measured grid came out at 49°.
        let s = site(bearing: 40)
        let g = geo(lat: s.centroidLatitude, lon: s.centroidLongitude)
        let placed = SitePlacement.place(site: s, geo: g, gridAngle: 49 * .pi / 180, rooms: [])
        XCTAssertTrue(axisAligned(placed.plan))
        XCTAssertTrue(placed.note.contains("compass snap 9°") || placed.note.contains("compass snap -9°"), placed.note)
        print("ASSERT: a 9° compass error shows up as the snap, not as a tilted outline")
    }

    func testInitialCompassPlacementKeepsUnsquaredFootprintAndEntryFix() {
        let s = site(bearing: 40)
        let mpd = SitePlacement.metersPerDegree(latitude: s.centroidLatitude)
        // The camera is at a known vertex: GPS and polygon must use one transform.
        let entrance = s.footprintEastNorth[0]
        let camera = Vec2(x: -2, y: -0.5)
        let g = geo(lat: s.centroidLatitude + entrance.y / mpd.lat,
                    lon: s.centroidLongitude + entrance.x / mpd.lon, cameraPlan: camera)
        for angle: Double? in [nil, 0, 49 * .pi / 180, 139 * .pi / 180] {
            let placed = SitePlacement.place(site: s, geo: g, gridAngle: angle, rooms: [])
            XCTAssertEqual(placed.plan[0].distance(to: camera), 0, accuracy: 1e-7,
                           "grid correction must pivot around the GPS camera fix")
            if angle == nil {
                XCTAssertFalse(axisAligned(placed.plan), "startup must retain the 40° geographic orientation")
                let edge = placed.plan[1] - placed.plan[0]
                XCTAssertEqual(atan2(edge.x, -edge.y) * 180 / .pi, 40, accuracy: 1e-6)
            }
        }
    }

    func testFinishingWholeWalkDoesNotMoveGPSAnchorToContainProvisionalBox() throws {
        let session = CaptureSession(name: "Entry anchor", capabilities: .simulated)
        session.updateTracking(.normal)
        _ = session.beginWalk(SimulatedHit.downward(x: 0, z: 0))
        var settings = session.settings
        settings.gridAngleOverride = 0
        session.updateSettings(settings)
        let s = site(bearing: 0)
        session.setGeo(geo(lat: s.centroidLatitude, lon: s.centroidLongitude, accuracy: 2.3))
        session.setSite(s)
        let initial = try XCTUnwrap(session.footprintPlan)
        for x in stride(from: 1.0, through: 30.0, by: 1) {
            _ = session.sampleWalk(SimulatedHit.downward(x: x, z: 3))
        }
        session.stopWalkRecording()
        XCTAssertEqual(session.rooms.count, 1)
        XCTAssertEqual(session.footprintPlan, initial, "an unsplit whole-house box is not room containment evidence")
    }

    func testNorthUpMapPreservesCardinalDirectionsAndCornerDragAfterGridRotation() {
        let angle = 40.0 * Double.pi / 180
        let origin = Vec2.zero
        let north = Vec2(x: 0, y: -5).rotated(by: -angle)
        let east = Vec2(x: 5, y: 0).rotated(by: -angle)
        let layout = PlanCanvasLayout.fitting(points: [origin, north, east],
                                             canvasSize: CGSize(width: 300, height: 300), rotation: angle)
        XCTAssertLessThan(layout.toScreen(north).y, layout.toScreen(origin).y)
        XCTAssertEqual(layout.toScreen(north).x, layout.toScreen(origin).x, accuracy: 1e-7)
        XCTAssertGreaterThan(layout.toScreen(east).x, layout.toScreen(origin).x)
        for p in [origin, north, east] {
            XCTAssertEqual(layout.toPlan(layout.toScreen(p)).distance(to: p), 0, accuracy: 1e-7)
        }
    }

    func testContainmentPullsFootprintOntoWalkedRooms() {
        let s = site(bearing: 0)
        // GPS says the centroid is 3 m east of the camera, but really the room the
        // user walked sits at x 6..10 (outside a footprint centred at x = 3, which
        // spans -2..8). The refinement should slide the outline east to cover it.
        let mpd = SitePlacement.metersPerDegree(latitude: s.centroidLatitude)
        let g = geo(lat: s.centroidLatitude, lon: s.centroidLongitude - 3 / mpd.lon)
        let room = [Vec2(x: 6, y: -3), Vec2(x: 10, y: -3), Vec2(x: 10, y: 0), Vec2(x: 6, y: 0)]
        let noRooms = SitePlacement.place(site: s, geo: g, gridAngle: 0, rooms: [])
        let withRoom = SitePlacement.place(site: s, geo: g, gridAngle: 0, rooms: [room])
        let cx0 = noRooms.plan.map(\.x).reduce(0, +) / 4, cx1 = withRoom.plan.map(\.x).reduce(0, +) / 4
        XCTAssertEqual(cx0, 3, accuracy: 1e-6)
        XCTAssertGreaterThan(cx1, cx0 + 1.5, "outline moved east to contain the room")
        XCTAssertTrue(room.allSatisfy { Geometry.pointInPolygon($0 + Vec2(x: 0.1, y: 0.1), withRoom.plan) || Geometry.pointInPolygon($0 - Vec2(x: 0.1, y: 0.1), withRoom.plan) })
        XCTAssertTrue(withRoom.note.contains("rooms inside 100%"), withRoom.note)
        print("ASSERT: GPS error is corrected by keeping walked rooms inside the outline")
    }

    func testGeoAndSiteSurviveExportAndRotation() throws {
        let session = CaptureSession(name: "Geo", capabilities: .simulated)
        session.updateTracking(.normal)
        _ = session.beginWalk(SimulatedHit.downward(x: 0, z: 0))
        for p in [(4.0, 0.0), (4.0, 3.0), (0.0, 3.0), (2.0, 3.0)] { _ = session.sampleWalk(SimulatedHit.downward(x: p.0, z: p.1)) }
        let s = site(bearing: 0)
        session.setGeo(geo(lat: s.centroidLatitude, lon: s.centroidLongitude, cameraPlan: Vec2(x: 2, y: 1.5)))
        session.setSite(s)
        XCTAssertNotNil(session.footprintPlan, "placed as soon as geo + site are known")
        _ = session.throughDoor()
        XCTAssertNotNil(session.site?.placementNote)
        let restored = try CaptureSession.fromJSON(session.exportedJSON())
        XCTAssertEqual(restored.geo?.latitude, s.centroidLatitude)
        XCTAssertEqual(restored.site?.footprintPlan?.count, 4)
        print("ASSERT: geo fix and placed footprint are part of the capture")
    }
}
