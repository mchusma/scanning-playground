import CoreGraphics
import Foundation

// MARK: - Floor-basis → 2D plan
//
// ARKit world tracking is gravity-aligned, right-handed, and measured in meters.
// Y is up. A confirmed floor is a plane through `origin` with normal `yAxis`
// (gravity up). The plan lives in that plane:
//
//   plan.x = dot(world - origin, xAxis)
//   plan.y = dot(world - origin, zAxis)
//
// where `xAxis` and `zAxis` are orthonormal in the floor plane and
// `xAxis × yAxis = zAxis`. These are meters, never screen pixels. Transforms
// and identifiers stay on the floor / room / doorway records so a later
// tracking segment cannot be mixed in without an explicit alignment.

struct Vec2: Codable, Equatable, Hashable {
    var x: Double
    var y: Double

    static let zero = Vec2(x: 0, y: 0)

    var length: Double { hypot(x, y) }

    func dot(_ other: Vec2) -> Double { x * other.x + y * other.y }

    func distance(to other: Vec2) -> Double {
        hypot(x - other.x, y - other.y)
    }

    func normalized() -> Vec2 {
        let len = length
        guard len > 1e-12 else { return .zero }
        return Vec2(x: x / len, y: y / len)
    }

    /// Counter-clockwise rotation by `angle` radians.
    func rotated(by angle: Double) -> Vec2 {
        let c = cos(angle)
        let s = sin(angle)
        return Vec2(x: x * c - y * s, y: x * s + y * c)
    }

    static func + (lhs: Vec2, rhs: Vec2) -> Vec2 { Vec2(x: lhs.x + rhs.x, y: lhs.y + rhs.y) }
    static func - (lhs: Vec2, rhs: Vec2) -> Vec2 { Vec2(x: lhs.x - rhs.x, y: lhs.y - rhs.y) }
    static func * (lhs: Vec2, rhs: Double) -> Vec2 { Vec2(x: lhs.x * rhs, y: lhs.y * rhs) }
    static func * (lhs: Double, rhs: Vec2) -> Vec2 { rhs * lhs }
}

struct Vec3: Codable, Equatable, Hashable {
    var x: Double
    var y: Double
    var z: Double

    static let zero = Vec3(x: 0, y: 0, z: 0)
    static let up = Vec3(x: 0, y: 1, z: 0)

    var length: Double { sqrt(x * x + y * y + z * z) }

    func dot(_ other: Vec3) -> Double { x * other.x + y * other.y + z * other.z }

    func cross(_ other: Vec3) -> Vec3 {
        Vec3(
            x: y * other.z - z * other.y,
            y: z * other.x - x * other.z,
            z: x * other.y - y * other.x
        )
    }

    func normalized() -> Vec3 {
        let len = length
        guard len > 1e-12 else { return .zero }
        return Vec3(x: x / len, y: y / len, z: z / len)
    }

    static func + (lhs: Vec3, rhs: Vec3) -> Vec3 {
        Vec3(x: lhs.x + rhs.x, y: lhs.y + rhs.y, z: lhs.z + rhs.z)
    }

    static func - (lhs: Vec3, rhs: Vec3) -> Vec3 {
        Vec3(x: lhs.x - rhs.x, y: lhs.y - rhs.y, z: lhs.z - rhs.z)
    }

    static func * (lhs: Vec3, rhs: Double) -> Vec3 {
        Vec3(x: lhs.x * rhs, y: lhs.y * rhs, z: lhs.z * rhs)
    }
}

struct FloorBasis: Codable, Equatable {
    var origin: Vec3
    var xAxis: Vec3
    var yAxis: Vec3
    var zAxis: Vec3
    var planeID: String?
    var segmentID: UUID

    /// Convert a world-space meter point into the 2D plan (meters).
    func toPlan(_ world: Vec3) -> Vec2 {
        let delta = world - origin
        return Vec2(x: delta.dot(xAxis), y: delta.dot(zAxis))
    }

    /// Lift a plan point back into world meters on this floor.
    func toWorld(_ plan: Vec2) -> Vec3 {
        origin + (xAxis * plan.x) + (zAxis * plan.y)
    }

    func heightDelta(of world: Vec3) -> Double {
        abs((world - origin).dot(yAxis))
    }

    /// Camera height above this floor for a hit. Positive when the ray started above the plane.
    func cameraHeight(of hit: PlacementHit) -> Double {
        (hit.rayOrigin - origin).dot(yAxis)
    }

    /// Rotate the in-plane axes about `yAxis`. A plan point `p` measured in the
    /// old basis becomes `p.rotated(by: -angle)` in the new one, so walls that
    /// ran at `angle` in the old plan become axis-aligned.
    func rotated(byYaw angle: Double) -> FloorBasis {
        let c = cos(angle)
        let s = sin(angle)
        var next = self
        next.xAxis = ((xAxis * c) + (zAxis * s)).normalized()
        next.zAxis = ((xAxis * -s) + (zAxis * c)).normalized()
        return next
    }

    static func gravityAligned(origin: Vec3, planeID: String?, segmentID: UUID = UUID()) -> FloorBasis {
        let up = Vec3.up
        var x = Vec3(x: 1, y: 0, z: 0)
        x = (x - (up * x.dot(up))).normalized()
        if x.length < 0.5 {
            x = Vec3(x: 0, y: 0, z: 1)
            x = (x - (up * x.dot(up))).normalized()
        }
        let z = x.cross(up).normalized()
        return FloorBasis(origin: origin, xAxis: x, yAxis: up, zAxis: z, planeID: planeID, segmentID: segmentID)
    }
}

enum PolygonIssue: Equatable {
    case tooFewPoints
    case duplicatePoint
    case degenerateEdge
    case selfIntersecting
}

enum Geometry {
    /// 2 cm — below this, points are the same corner / an edge has no length.
    static let pointEpsilon: Double = 0.02
    /// Reject rays whose direction is within ~8° of parallel to the floor.
    static let minRayFloorDot: Double = 0.15
    static let minHitDistance: Double = 0.05
    static let maxHitDistance: Double = 20.0
    /// Report, do not flatten, a step / stair this high.
    static let floorHeightWarn: Double = 0.25
    static let doorwayOnWallSlop: Double = 0.03
    static let mismatchDistance: Double = 0.15
    static let mismatchAngleDegrees: Double = 15

    // Walk sampling. The analytic floor plane is infinite, so a shallow glance
    // (say, at a panel across the room) would land a sample far outside the
    // room. Walk samples must be steep and close.
    /// ~17° below horizontal or steeper.
    static let walkMinRayFloorDot: Double = 0.3
    static let walkMaxHitDistance: Double = 4.0
    /// A chest-height phone is ≥ 0.7 m above the floor; a tabletop is not.
    static let minFloorCameraHeight: Double = 0.7
    static let maxFloorCameraHeight: Double = 2.2
    /// Distance from the phone to the wall when someone walks along it:
    /// half a body plus a comfortable gap. Applied around the camera path.
    static let walkPad: Double = 0.5
    /// Shared-wall snap: shrink a new room box by at most this much to meet
    /// its neighbour. Two padded boxes meeting at a doorway overlap by ~2 × walkPad.
    static let sharedWallMaxShift: Double = 1.2
    static let sharedWallMaxGap: Double = 0.35

    static func signedArea(_ points: [Vec2]) -> Double {
        guard points.count >= 3 else { return 0 }
        var sum = 0.0
        for i in 0..<points.count {
            let a = points[i]
            let b = points[(i + 1) % points.count]
            sum += a.x * b.y - b.x * a.y
        }
        return sum / 2
    }

    static func validatePolyline(_ points: [Vec2]) -> PolygonIssue? {
        guard points.count >= 2 else { return nil }
        for i in 1..<points.count {
            if points[i].distance(to: points[i - 1]) < pointEpsilon {
                return .degenerateEdge
            }
        }
        for i in 0..<points.count {
            for j in (i + 1)..<points.count {
                if points[i].distance(to: points[j]) < pointEpsilon {
                    if j == i + 1 { return .degenerateEdge }
                    return .duplicatePoint
                }
            }
        }
        // New edge vs non-adjacent earlier edges.
        if points.count >= 4 {
            let n = points.count
            let a1 = points[n - 2]
            let a2 = points[n - 1]
            for i in 0..<(n - 3) {
                if segmentsIntersect(a1, a2, points[i], points[i + 1]) {
                    return .selfIntersecting
                }
            }
        }
        return nil
    }

    static func validateClosedPolygon(_ points: [Vec2]) -> PolygonIssue? {
        if points.count < 3 { return .tooFewPoints }
        if let issue = validatePolyline(points) { return issue }
        let n = points.count
        if points[0].distance(to: points[n - 1]) < pointEpsilon {
            return .degenerateEdge
        }
        // Closing edge vs non-adjacent edges.
        let closeA = points[n - 1]
        let closeB = points[0]
        if n >= 4 {
            for i in 1..<(n - 2) {
                if segmentsIntersect(closeA, closeB, points[i], points[i + 1]) {
                    return .selfIntersecting
                }
            }
        }
        for i in 0..<n {
            let a1 = points[i]
            let a2 = points[(i + 1) % n]
            if a1.distance(to: a2) < pointEpsilon { return .degenerateEdge }
            for j in 0..<n {
                if i >= j { continue }
                let shareVertex = abs(i - j) <= 1 || (i == 0 && j == n - 1) || (j == 0 && i == n - 1)
                    || (i + 1) % n == j || (j + 1) % n == i
                if shareVertex { continue }
                let b1 = points[j]
                let b2 = points[(j + 1) % n]
                if segmentsIntersect(a1, a2, b1, b2) {
                    return .selfIntersecting
                }
            }
        }
        return nil
    }

    /// Proper intersection, including colinear overlap. Shared endpoints alone do not count.
    static func segmentsIntersect(_ a1: Vec2, _ a2: Vec2, _ b1: Vec2, _ b2: Vec2) -> Bool {
        let endpointSlop = 0.001
        if a1.distance(to: b1) < endpointSlop || a1.distance(to: b2) < endpointSlop
            || a2.distance(to: b1) < endpointSlop || a2.distance(to: b2) < endpointSlop
        {
            return colinearOverlap(a1, a2, b1, b2)
        }
        let o1 = orientation(a1, a2, b1)
        let o2 = orientation(a1, a2, b2)
        let o3 = orientation(b1, b2, a1)
        let o4 = orientation(b1, b2, a2)
        if o1 != 0 && o2 != 0 && o3 != 0 && o4 != 0 && o1 != o2 && o3 != o4 {
            return true
        }
        if o1 == 0 && onSegment(a1, a2, b1) { return true }
        if o2 == 0 && onSegment(a1, a2, b2) { return true }
        if o3 == 0 && onSegment(b1, b2, a1) { return true }
        if o4 == 0 && onSegment(b1, b2, a2) { return true }
        return false
    }

    private static func colinearOverlap(_ a1: Vec2, _ a2: Vec2, _ b1: Vec2, _ b2: Vec2) -> Bool {
        if orientation(a1, a2, b1) != 0 || orientation(a1, a2, b2) != 0 { return false }
        // Project onto the dominant axis and look for a proper interval overlap
        // that is more than a shared endpoint.
        let useX = abs(a2.x - a1.x) >= abs(a2.y - a1.y)
        func span(_ p: Vec2, _ q: Vec2) -> (Double, Double) {
            let u = useX ? p.x : p.y
            let v = useX ? q.x : q.y
            return (min(u, v), max(u, v))
        }
        let a = span(a1, a2)
        let b = span(b1, b2)
        let overlap = min(a.1, b.1) - max(a.0, b.0)
        return overlap > endpointOverlapTolerance
    }

    private static let endpointOverlapTolerance = 0.005

    /// 0 colinear, 1 clockwise, 2 counterclockwise.
    static func orientation(_ a: Vec2, _ b: Vec2, _ c: Vec2) -> Int {
        let v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
        if abs(v) < 1e-12 { return 0 }
        return v > 0 ? 1 : 2
    }

    static func onSegment(_ a: Vec2, _ b: Vec2, _ p: Vec2) -> Bool {
        min(a.x, b.x) - 1e-9 <= p.x && p.x <= max(a.x, b.x) + 1e-9
            && min(a.y, b.y) - 1e-9 <= p.y && p.y <= max(a.y, b.y) + 1e-9
    }

    /// Right-angle convenience. Does not replace the raw capture.
    static func snapRightAngle(previous: [Vec2], raw: Vec2) -> Vec2 {
        if previous.isEmpty { return raw }
        if previous.count == 1 {
            let first = previous[0]
            let dx = raw.x - first.x
            let dy = raw.y - first.y
            if abs(dx) >= abs(dy) {
                return Vec2(x: raw.x, y: first.y)
            }
            return Vec2(x: first.x, y: raw.y)
        }
        let a = previous[previous.count - 2]
        let b = previous[previous.count - 1]
        let edge = b - a
        let len = edge.length
        guard len > 1e-9 else { return raw }
        let dir = edge.normalized()
        let normal = Vec2(x: -dir.y, y: dir.x)
        let v = raw - b
        let alongNormal = normal * v.dot(normal)
        let alongDir = dir * v.dot(dir)
        // Prefer the 90° continuation; fall back to axis-aligned if that is tiny.
        if alongNormal.length >= 0.05 {
            return b + alongNormal
        }
        if alongDir.length >= 0.05 {
            return b + (normal * (v.dot(normal) >= 0 ? alongDir.length : -alongDir.length))
        }
        return b + alongNormal
    }

    static func projectToSegment(_ point: Vec2, a: Vec2, b: Vec2) -> (point: Vec2, t: Double, distance: Double) {
        let ab = b - a
        let len2 = ab.dot(ab)
        if len2 < 1e-12 {
            return (a, 0, point.distance(to: a))
        }
        var t = (point - a).dot(ab) / len2
        t = min(1, max(0, t))
        let projected = a + ab * t
        return (projected, t, point.distance(to: projected))
    }

    static func closestEdge(polygon: [Vec2], point: Vec2) -> (index: Int, t: Double, projected: Vec2, distance: Double)? {
        guard polygon.count >= 2 else { return nil }
        var best: (Int, Double, Vec2, Double)?
        for i in 0..<polygon.count {
            let a = polygon[i]
            let b = polygon[(i + 1) % polygon.count]
            let hit = projectToSegment(point, a: a, b: b)
            if best == nil || hit.distance < best!.3 {
                best = (i, hit.t, hit.point, hit.distance)
            }
        }
        return best.map { (index: $0.0, t: $0.1, projected: $0.2, distance: $0.3) }
    }

    static func pointOnEdge(_ point: Vec2, polygon: [Vec2], edgeIndex: Int, slop: Double = doorwayOnWallSlop) -> (point: Vec2, t: Double)? {
        guard polygon.count >= 2, edgeIndex >= 0, edgeIndex < polygon.count else { return nil }
        let a = polygon[edgeIndex]
        let b = polygon[(edgeIndex + 1) % polygon.count]
        let hit = projectToSegment(point, a: a, b: b)
        if hit.distance > slop { return nil }
        return (hit.point, hit.t)
    }

    static func doorwayFromCenter(polygon: [Vec2], edgeIndex: Int, centerT: Double, width: Double) -> (Vec2, Vec2)? {
        guard polygon.count >= 2, edgeIndex >= 0, edgeIndex < polygon.count, width > pointEpsilon else { return nil }
        let a = polygon[edgeIndex]
        let b = polygon[(edgeIndex + 1) % polygon.count]
        let ab = b - a
        let len = ab.length
        guard len > pointEpsilon else { return nil }
        let dir = ab.normalized()
        let t = min(1, max(0, centerT))
        let center = a + ab * t
        let half = width / 2
        var p0 = center + dir * -half
        var p1 = center + dir * half
        // Clamp onto the segment.
        func clampToEdge(_ p: Vec2) -> Vec2 {
            projectToSegment(p, a: a, b: b).point
        }
        p0 = clampToEdge(p0)
        p1 = clampToEdge(p1)
        if p0.distance(to: p1) < pointEpsilon { return nil }
        return (p0, p1)
    }

    static func edgeDirection(polygon: [Vec2], edgeIndex: Int) -> Vec2? {
        guard polygon.count >= 2, edgeIndex >= 0, edgeIndex < polygon.count else { return nil }
        let a = polygon[edgeIndex]
        let b = polygon[(edgeIndex + 1) % polygon.count]
        let d = b - a
        guard d.length > 1e-9 else { return nil }
        return d.normalized()
    }

    static func angleDegrees(_ a: Vec2, _ b: Vec2) -> Double {
        let da = a.normalized()
        let db = b.normalized()
        let c = min(1, max(-1, da.dot(db)))
        return acos(c) * 180 / .pi
    }

    static func bounds(_ points: [Vec2]) -> (min: Vec2, max: Vec2)? {
        guard let first = points.first else { return nil }
        var lo = first
        var hi = first
        for p in points {
            lo.x = min(lo.x, p.x)
            lo.y = min(lo.y, p.y)
            hi.x = max(hi.x, p.x)
            hi.y = max(hi.y, p.y)
        }
        return (lo, hi)
    }

    /// Walk-mode room: axis-aligned box around where the phone went, padded
    /// out to where the walls are. Simplicity over corner accuracy.
    static func roomBox(from samples: [Vec2], pad: Double = walkPad, minSide: Double = 1.2) -> [Vec2] {
        let seed = samples.isEmpty ? [Vec2.zero] : samples
        guard var b = bounds(seed) else {
            return [
                Vec2(x: -minSide / 2, y: -minSide / 2),
                Vec2(x: minSide / 2, y: -minSide / 2),
                Vec2(x: minSide / 2, y: minSide / 2),
                Vec2(x: -minSide / 2, y: minSide / 2)
            ]
        }
        b.min.x -= pad
        b.min.y -= pad
        b.max.x += pad
        b.max.y += pad
        if b.max.x - b.min.x < minSide {
            let mid = (b.min.x + b.max.x) / 2
            b.min.x = mid - minSide / 2
            b.max.x = mid + minSide / 2
        }
        if b.max.y - b.min.y < minSide {
            let mid = (b.min.y + b.max.y) / 2
            b.min.y = mid - minSide / 2
            b.max.y = mid + minSide / 2
        }
        return [
            Vec2(x: b.min.x, y: b.min.y),
            Vec2(x: b.max.x, y: b.min.y),
            Vec2(x: b.max.x, y: b.max.y),
            Vec2(x: b.min.x, y: b.max.y)
        ]
    }

    /// The person tapped Through a door while standing in it, so `point` is on
    /// the wall plane. Pull the box edge nearest to it back to pass through
    /// it — but only inward and only by about one pad; anything more means
    /// the point is not on that wall.
    static func pinBoxEdge(_ box: [Vec2], to point: Vec2, maxPull: Double = walkPad + 0.15, minSide: Double = 1.2) -> [Vec2] {
        guard var b = bounds(box) else { return box }
        let candidates: [(pull: Double, apply: () -> Void)] = [
            (b.max.x - point.x, { b.max.x = point.x }),
            (point.x - b.min.x, { b.min.x = point.x }),
            (b.max.y - point.y, { b.max.y = point.y }),
            (point.y - b.min.y, { b.min.y = point.y })
        ]
        guard let best = candidates.filter({ $0.pull >= 0 }).min(by: { $0.pull < $1.pull }),
              best.pull <= maxPull
        else { return box }
        best.apply()
        if b.max.x - b.min.x < minSide || b.max.y - b.min.y < minSide { return box }
        return [
            Vec2(x: b.min.x, y: b.min.y),
            Vec2(x: b.max.x, y: b.min.y),
            Vec2(x: b.max.x, y: b.max.y),
            Vec2(x: b.min.x, y: b.max.y)
        ]
    }

    /// Even-odd point-in-polygon test.
    static func pointInPolygon(_ p: Vec2, _ poly: [Vec2]) -> Bool {
        guard poly.count >= 3 else { return false }
        var inside = false
        var j = poly.count - 1
        for i in 0..<poly.count {
            let a = poly[i], b = poly[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    /// Width × depth of a polygon's bounds, in meters.
    static func size(of points: [Vec2]) -> (width: Double, depth: Double)? {
        guard let b = bounds(points) else { return nil }
        return (b.max.x - b.min.x, b.max.y - b.min.y)
    }

    /// Dominant wall heading of a walk path, folded into (-45°, 45°].
    ///
    /// People walk along walls, so segment directions cluster at the wall
    /// orientation and its perpendicular. Folding every direction modulo 90°
    /// makes those headings coincide. A length-weighted histogram finds the
    /// peak; only segments near the peak vote in the final mean, so the
    /// diagonal walk to a doorway or across to an appliance does not tilt the
    /// grid. Returns nil when the walk is too short or has no clear heading.
    static func dominantAngle(
        of samples: [Vec2],
        minSegment: Double = 0.15,
        minTotalLength: Double = 2.0,
        minInlierFraction: Double = 0.4,
        inlierWindowDegrees: Double = 6
    ) -> Double? {
        guard samples.count >= 2 else { return nil }
        var headings: [(angle: Double, weight: Double)] = []
        for i in 1..<samples.count {
            let d = samples[i] - samples[i - 1]
            let len = d.length
            if len < minSegment { continue }
            headings.append((atan2(d.y, d.x), len))
        }
        return dominantAngle(headings: headings, minTotalWeight: minTotalLength, minInlierFraction: minInlierFraction, inlierWindowDegrees: inlierWindowDegrees)
    }

    /// Grid heading from where the phone *faced*. People walk along walls and
    /// turn to face what they show, so yaw samples cluster on the wall grid
    /// even when the path itself wanders around an island. Each sample is one
    /// vote; needs `minSamples` of them.
    static func dominantAngle(
        yaws: [Double],
        minSamples: Int = 40,
        minInlierFraction: Double = 0.35,
        inlierWindowDegrees: Double = 12
    ) -> Double? {
        guard yaws.count >= minSamples else { return nil }
        return dominantAngle(
            headings: yaws.map { ($0, 1.0) },
            minTotalWeight: Double(minSamples),
            minInlierFraction: minInlierFraction,
            inlierWindowDegrees: inlierWindowDegrees
        )
    }

    /// Weighted headings (radians, any range) → grid angle in (-45°, 45°].
    static func dominantAngle(
        headings: [(angle: Double, weight: Double)],
        minTotalWeight: Double,
        minInlierFraction: Double,
        inlierWindowDegrees: Double
    ) -> Double? {
        let quarter = Double.pi / 2
        var segments: [(angle: Double, length: Double)] = []
        var total = 0.0
        for h in headings where h.weight > 0 {
            var theta = h.angle.truncatingRemainder(dividingBy: quarter)
            if theta < 0 { theta += quarter }
            segments.append((theta, h.weight))
            total += h.weight
        }
        guard total >= minTotalWeight else { return nil }

        // Peak of a 3° histogram over [0, 90°), smoothed with its neighbours.
        let binCount = 30
        var bins = [Double](repeating: 0, count: binCount)
        for seg in segments {
            let idx = min(binCount - 1, Int(seg.angle / quarter * Double(binCount)))
            bins[idx] += seg.length
        }
        var peak = 0
        var peakWeight = -1.0
        for i in 0..<binCount {
            let w = bins[(i + binCount - 1) % binCount] + bins[i] + bins[(i + 1) % binCount]
            if w > peakWeight {
                peakWeight = w
                peak = i
            }
        }
        let peakAngle = (Double(peak) + 0.5) / Double(binCount) * quarter

        // Inliers within the window (circular distance modulo 90°), then a
        // circular mean using the 4θ trick.
        let window = inlierWindowDegrees * .pi / 180
        var sx = 0.0
        var sy = 0.0
        var inlierLength = 0.0
        for seg in segments {
            var delta = abs(seg.angle - peakAngle)
            delta = min(delta, quarter - delta)
            if delta > window { continue }
            sx += seg.length * cos(4 * seg.angle)
            sy += seg.length * sin(4 * seg.angle)
            inlierLength += seg.length
        }
        guard inlierLength >= minTotalWeight, inlierLength / total >= minInlierFraction else { return nil }
        return atan2(sy, sx) / 4
    }

    /// Best grid estimate from a walk: phone heading first, path second.
    static func gridAngle(poses: [WalkPose], path: [Vec2]) -> Double? {
        if let yaw = dominantAngle(yaws: poses.compactMap(\.yaw)) { return yaw }
        return dominantAngle(of: path)
    }

    /// Snap an axis-aligned room box to share a wall with an axis-aligned
    /// neighbour. Only the *new* box moves, only on the side facing the
    /// neighbour, and only by a small amount. Larger disagreements are left
    /// alone so they can be shown as mismatches rather than hidden.
    static func snapBoxToNeighbor(
        _ box: [Vec2],
        neighbor: [Vec2],
        maxShift: Double = sharedWallMaxShift,
        maxGap: Double = sharedWallMaxGap,
        minSide: Double = 1.2
    ) -> (box: [Vec2], shift: Double)? {
        guard var b = bounds(box), let n = bounds(neighbor) else { return nil }
        let overlapX = min(b.max.x, n.max.x) - max(b.min.x, n.min.x)
        let overlapY = min(b.max.y, n.max.y) - max(b.min.y, n.min.y)

        // Which axis separates the rooms? The one with the smaller overlap
        // (negative overlap is a gap). The other axis must actually overlap,
        // otherwise the rooms are diagonal neighbours, not wall-sharing ones.
        let separateOnX = overlapX <= overlapY
        let separation = separateOnX ? overlapX : overlapY
        let other = separateOnX ? overlapY : overlapX
        guard other > 0.3 else { return nil }
        if separation > maxShift || separation < -maxGap { return nil }

        let bCenter = separateOnX ? (b.min.x + b.max.x) / 2 : (b.min.y + b.max.y) / 2
        let nCenter = separateOnX ? (n.min.x + n.max.x) / 2 : (n.min.y + n.max.y) / 2
        let newIsHigher = bCenter >= nCenter
        var shift = 0.0
        if separateOnX {
            if newIsHigher {
                shift = n.max.x - b.min.x
                b.min.x = n.max.x
            } else {
                shift = b.max.x - n.min.x
                b.max.x = n.min.x
            }
            if b.max.x - b.min.x < minSide { return nil }
        } else {
            if newIsHigher {
                shift = n.max.y - b.min.y
                b.min.y = n.max.y
            } else {
                shift = b.max.y - n.min.y
                b.max.y = n.min.y
            }
            if b.max.y - b.min.y < minSide { return nil }
        }
        let snapped = [
            Vec2(x: b.min.x, y: b.min.y),
            Vec2(x: b.max.x, y: b.min.y),
            Vec2(x: b.max.x, y: b.max.y),
            Vec2(x: b.min.x, y: b.max.y)
        ]
        return (snapped, shift)
    }
}

struct ExtrudedRoom: Equatable {
    var roomID: UUID
    var footprint: [Vec2]
    var height: Double
}

enum Extrusion {
    /// Illustrative walls. Height is not measured; footprints are the same 2D polygons.
    static let defaultWallHeight = 2.5

    static func extrude(rooms: [Room], wallHeight: Double = defaultWallHeight) -> [ExtrudedRoom] {
        rooms.map { ExtrudedRoom(roomID: $0.id, footprint: $0.displayPolygon, height: wallHeight) }
    }
}

/// Shared 2D plan ↔ canvas mapping used by the review editor. Finger locations
/// must be in this canvas space, not in a handle's local 16×16 bounds.
/// Map world z (south) down the screen, preserving handedness. A heading-aligned
/// capture can undo its measured grid rotation for a stable north-up display.
struct PlanCanvasLayout: Equatable {
    var boundsMin: Vec2
    var boundsMax: Vec2
    var pad: Double
    var canvasSize: CGSize
    var rotation: Double = 0

    var scale: Double {
        let widthM = max(2, boundsMax.x - boundsMin.x + pad * 2)
        let heightM = max(2, boundsMax.y - boundsMin.y + pad * 2)
        guard canvasSize.width > 0, canvasSize.height > 0 else { return 1 }
        return min(canvasSize.width / widthM, canvasSize.height / heightM)
    }

    func toScreen(_ p: Vec2) -> CGPoint {
        let displayed = p.rotated(by: rotation)
        return CGPoint(x: (displayed.x - (boundsMin.x - pad)) * scale,
                       y: (displayed.y - (boundsMin.y - pad)) * scale)
    }

    func toPlan(_ s: CGPoint) -> Vec2 {
        Vec2(x: Double(s.x) / scale + (boundsMin.x - pad),
             y: Double(s.y) / scale + (boundsMin.y - pad)).rotated(by: -rotation)
    }

    static func fitting(points: [Vec2], canvasSize: CGSize, pad: Double = 1.2, rotation: Double = 0) -> PlanCanvasLayout {
        let b = Geometry.bounds(points.map { $0.rotated(by: rotation) }) ?? (min: Vec2(x: -1, y: -1), max: Vec2(x: 1, y: 1))
        return PlanCanvasLayout(boundsMin: b.min, boundsMax: b.max, pad: pad, canvasSize: canvasSize, rotation: rotation)
    }
}

/// Simulator aim: placement reads `x`/`z`. Text fields apply only via `applyTextFields()`.
struct SimulatorAimState: Equatable {
    var x: Double = 0
    var z: Double = 0
    var xText = "0.0"
    var zText = "0.0"

    mutating func set(x: Double, z: Double) {
        self.x = x
        self.z = z
        xText = String(format: "%.2f", x)
        zText = String(format: "%.2f", z)
    }

    mutating func applyTextFields() {
        set(x: Double(xText) ?? x, z: Double(zText) ?? z)
    }

    func hit(worldY: Double = 0) -> PlacementHit {
        PlacementHit(
            world: Vec3(x: x, y: worldY, z: z),
            rayOrigin: Vec3(x: x, y: 1.5, z: z),
            rayDirection: Vec3(x: 0, y: -1, z: 0),
            distance: abs(1.5 - worldY),
            candidatePlaneID: "simulated-floor"
        )
    }
}

/// Simulator floor grid: origin at the canvas center, +X right, +Z up the screen.
struct SimulatorFloorMap: Equatable {
    static let visibleMeters: Double = 10
    var canvasSize: CGSize

    var scale: Double {
        guard canvasSize.width > 0, canvasSize.height > 0 else { return 1 }
        return min(canvasSize.width, canvasSize.height) / Self.visibleMeters
    }

    var origin: CGPoint {
        CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
    }

    func toScreen(_ v: Vec2) -> CGPoint {
        CGPoint(x: origin.x + v.x * scale, y: origin.y - v.y * scale)
    }

    func toPlan(_ s: CGPoint) -> Vec2 {
        Vec2(x: (Double(s.x) - origin.x) / scale, y: (origin.y - Double(s.y)) / scale)
    }
}
