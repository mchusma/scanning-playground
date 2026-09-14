import XCTest
@testable import HomeWalk

/// Walk-mode measurement: the box a customer gets must be the room they walked,
/// not the AR world's heading, not a glance through a wall, not the previous room.
final class WalkGeometryTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func hit(_ x: Double, _ z: Double) -> PlacementHit {
        SimulatedHit.downward(x: x, z: z)
    }

    /// A hit whose camera is somewhere other than straight above the hit.
    private func hit(world: Vec2, camera: Vec2, cameraHeight: Double = 1.5) -> PlacementHit {
        let w = Vec3(x: world.x, y: 0, z: world.y)
        let o = Vec3(x: camera.x, y: cameraHeight, z: camera.y)
        let d = (w - o)
        return PlacementHit(world: w, rayOrigin: o, rayDirection: d.normalized(), distance: d.length, candidatePlaneID: "simulated-floor")
    }

    private func rotate(_ p: Vec2, degrees: Double) -> Vec2 {
        p.rotated(by: degrees * .pi / 180)
    }

    private func size(_ poly: [Vec2]) -> (Double, Double) {
        let s = Geometry.size(of: poly)!
        return (s.width, s.depth)
    }

    @discardableResult
    private func mustOK(_ result: CaptureResult, _ file: StaticString = #filePath, _ line: UInt = #line) -> Bool {
        if case .failed(let err) = result {
            XCTFail("expected ok, got \(err)", file: file, line: line)
            return false
        }
        return true
    }

    // MARK: Geometry

    func testDominantAngleRecoversRotatedWalls() {
        let corners = [Vec2(x: 0, y: 0), Vec2(x: 4, y: 0), Vec2(x: 4, y: 3), Vec2(x: 0, y: 3), Vec2(x: 0, y: 0)]
        for degrees in [0.0, 12.0, 25.0, -30.0, 44.0] {
            let path = corners.map { rotate($0, degrees: degrees) }
            let angle = Geometry.dominantAngle(of: path)
            XCTAssertNotNil(angle, "angle for \(degrees)°")
            XCTAssertEqual(angle! * 180 / .pi, degrees, accuracy: 0.5, "rotated walls at \(degrees)°")
        }
        // 90° folds to 0: the grid is the same.
        let ninety = corners.map { rotate($0, degrees: 90) }
        XCTAssertEqual(Geometry.dominantAngle(of: ninety)! * 180 / .pi, 0, accuracy: 0.5)
        print("ASSERT: dominant wall heading recovered from a walked rectangle at any rotation")
    }

    func testDominantAngleIgnoresDiagonalExcursions() {
        // Walk the walls of a 4×3 room at 20°, then cut diagonally to the door
        // and across to an appliance. The grid must stay at 20°.
        let degrees = 20.0
        let walls = [Vec2(x: 0, y: 0), Vec2(x: 4, y: 0), Vec2(x: 4, y: 3), Vec2(x: 0, y: 3), Vec2(x: 0, y: 0)]
        let excursions = [Vec2(x: 3.5, y: 2.5), Vec2(x: 0.5, y: 1.0), Vec2(x: 4, y: 1.5)]
        let path = (walls + excursions).map { rotate($0, degrees: degrees) }
        let angle = Geometry.dominantAngle(of: path)
        XCTAssertNotNil(angle)
        XCTAssertEqual(angle! * 180 / .pi, degrees, accuracy: 0.5)
        print("ASSERT: diagonal excursions do not tilt the wall grid")
    }

    func testPhoneHeadingRecoversTheGridDespiteTurnsAndWander() {
        // A walk where the person faces along walls and squarely at things
        // (all on a 20° grid) most of the time, with turns and wandering in
        // between. Yaw votes should recover 20° even though the path itself
        // (an island loop) would not.
        var rng = SystemRandomNumberGenerator()
        let grid = 20.0 * .pi / 180
        var yaws: [Double] = []
        for i in 0..<200 {
            if i % 5 == 4 {
                yaws.append(Double.random(in: -Double.pi...Double.pi, using: &rng))   // turning
            } else {
                let facing = grid + Double(Int.random(in: 0..<4, using: &rng)) * .pi / 2
                yaws.append(facing + Double.random(in: -0.06...0.06, using: &rng))   // ±3.4° wobble
            }
        }
        let angle = Geometry.dominantAngle(yaws: yaws)
        XCTAssertNotNil(angle)
        XCTAssertEqual(angle! * 180 / .pi, 20, accuracy: 1.5)

        // Too few votes: no claim.
        XCTAssertNil(Geometry.dominantAngle(yaws: Array(yaws.prefix(20))))
        // Uniform headings: no claim.
        let uniform = (0..<200).map { Double($0) / 200 * 2 * .pi }
        XCTAssertNil(Geometry.dominantAngle(yaws: uniform))

        // gridAngle prefers yaw; falls back to the path.
        let poses = yaws.map { WalkPose(t: 0, camera: .zero, hit: nil, cameraHeight: 1.4, yaw: $0) }
        XCTAssertEqual(Geometry.gridAngle(poses: poses, path: [])! * 180 / .pi, 20, accuracy: 1.5)
        let noYaw = poses.map { p -> WalkPose in var q = p; q.yaw = nil; return q }
        let path = [Vec2(x: 0, y: 0), Vec2(x: 4, y: 0), Vec2(x: 4, y: 3), Vec2(x: 0, y: 3)].map { rotate($0, degrees: 10) }
        XCTAssertEqual(Geometry.gridAngle(poses: noYaw, path: path)! * 180 / .pi, 10, accuracy: 0.5)
        print("ASSERT: phone heading votes recover the wall grid through turns and wander")
    }

    func testDominantAngleRefusesShortOrCurvyPaths() {
        XCTAssertNil(Geometry.dominantAngle(of: [Vec2(x: 0, y: 0), Vec2(x: 0.5, y: 0)]), "too short")
        // A circle has no dominant heading.
        var circle: [Vec2] = []
        for i in 0...40 {
            let t = Double(i) / 40 * 2 * .pi
            circle.append(Vec2(x: 3 * cos(t), y: 3 * sin(t)))
        }
        XCTAssertNil(Geometry.dominantAngle(of: circle), "circle has no grid")
        print("ASSERT: no grid is claimed from a short or directionless walk")
    }

    func testBasisRotationMakesRotatedRoomAxisAligned() {
        let basis = FloorBasis.gravityAligned(origin: .zero, planeID: nil)
        let degrees = 25.0
        let corners = [Vec2(x: 0, y: 0), Vec2(x: 4, y: 0), Vec2(x: 4, y: 3), Vec2(x: 0, y: 3), Vec2(x: 0, y: 0)]
        let worldPts = corners.map { rotate($0, degrees: degrees) }.map { basis.toWorld($0) }
        let planBefore = worldPts.map { basis.toPlan($0) }
        let before = size(Geometry.roomBox(from: planBefore, pad: 0, minSide: 0))
        XCTAssertGreaterThan(before.0, 4.5, "unaligned box is inflated")

        let angle = Geometry.dominantAngle(of: planBefore)!
        let aligned = basis.rotated(byYaw: angle)
        let planAfter = worldPts.map { aligned.toPlan($0) }
        let after = size(Geometry.roomBox(from: planAfter, pad: 0, minSide: 0))
        XCTAssertEqual(after.0, 4, accuracy: 0.02)
        XCTAssertEqual(after.1, 3, accuracy: 0.02)
        // The convenience rotation on plan points must agree with the basis rotation.
        for (a, b) in zip(planBefore.map { $0.rotated(by: -angle) }, planAfter) {
            XCTAssertEqual(a.x, b.x, accuracy: 1e-9)
            XCTAssertEqual(a.y, b.y, accuracy: 1e-9)
        }
        // Round trip world → plan → world survives the rotation.
        for (w, p) in zip(worldPts, planAfter) {
            let back = aligned.toWorld(p)
            XCTAssertEqual(back.x, w.x, accuracy: 1e-9)
            XCTAssertEqual(back.z, w.z, accuracy: 1e-9)
        }
        print("ASSERT: rotating the floor basis to the wall heading removes the AABB inflation")
    }

    func testSharedWallSnapOnlyMovesSmallOverlapsAndGaps() {
        let kitchen = [Vec2(x: -0.35, y: -0.35), Vec2(x: 4.35, y: -0.35), Vec2(x: 4.35, y: 3.35), Vec2(x: -0.35, y: 3.35)]
        // Overlaps 0.2 m into the kitchen: snap to x = 4.35.
        let hall = [Vec2(x: 4.15, y: 0), Vec2(x: 8.35, y: 0), Vec2(x: 8.35, y: 3), Vec2(x: 4.15, y: 3)]
        let snapped = Geometry.snapBoxToNeighbor(hall, neighbor: kitchen)
        XCTAssertNotNil(snapped)
        XCTAssertEqual(snapped!.shift, 0.2, accuracy: 1e-9)
        XCTAssertEqual(snapped!.box.map(\.x).min()!, 4.35, accuracy: 1e-9)
        XCTAssertEqual(snapped!.box.map(\.x).max()!, 8.35, accuracy: 1e-9, "far wall untouched")

        // Small gap (wall thickness): close it.
        let gap = [Vec2(x: 4.55, y: 0), Vec2(x: 8, y: 0), Vec2(x: 8, y: 3), Vec2(x: 4.55, y: 3)]
        let closed = Geometry.snapBoxToNeighbor(gap, neighbor: kitchen)
        XCTAssertEqual(closed!.box.map(\.x).min()!, 4.35, accuracy: 1e-9)

        // Big overlap: leave it, it's a disagreement to show, not hide.
        let deep = [Vec2(x: 2, y: 0), Vec2(x: 8, y: 0), Vec2(x: 8, y: 3), Vec2(x: 2, y: 3)]
        XCTAssertNil(Geometry.snapBoxToNeighbor(deep, neighbor: kitchen))

        // Diagonal neighbour (no overlap on the other axis): not a shared wall.
        let diagonal = [Vec2(x: 4.2, y: 4), Vec2(x: 8, y: 4), Vec2(x: 8, y: 7), Vec2(x: 4.2, y: 7)]
        XCTAssertNil(Geometry.snapBoxToNeighbor(diagonal, neighbor: kitchen))

        // Neighbour below on Y: snap on Y, leave X alone.
        let south = [Vec2(x: 0, y: -3.5), Vec2(x: 4, y: -3.5), Vec2(x: 4, y: -0.1), Vec2(x: 0, y: -0.1)]
        let s = Geometry.snapBoxToNeighbor(south, neighbor: kitchen)!
        XCTAssertEqual(s.box.map(\.y).max()!, -0.35, accuracy: 1e-9)
        XCTAssertEqual(s.box.map(\.x).min()!, 0, accuracy: 1e-9)
        print("ASSERT: shared-wall snap is bounded, one-sided, and refuses large disagreements")
    }

    // MARK: Session

    func testFirstRoomBoxIsAlignedToItsWalls() {
        let session = CaptureSession(name: "Rotated", capabilities: .simulated)
        session.updateTracking(.normal)
        let degrees = 25.0
        // Round the room, then into a doorway in the middle of the south wall.
        let corners = [Vec2(x: 0, y: 0), Vec2(x: 4, y: 0), Vec2(x: 4, y: 3), Vec2(x: 0, y: 3), Vec2(x: 0, y: 0), Vec2(x: 2, y: 0)]
        let walked = corners.map { rotate($0, degrees: degrees) }
        mustOK(session.beginWalk(hit(walked[0].x, walked[0].y)))
        for p in walked.dropFirst() { mustOK(session.sampleWalk(hit(p.x, p.y))) }
        XCTAssertFalse(session.gridAligned)
        mustOK(session.throughDoor())
        XCTAssertTrue(session.gridAligned)
        XCTAssertEqual(session.floor!.gridAngle! * 180 / .pi, degrees, accuracy: 0.5)
        let room = session.rooms[0]
        let s = size(room.displayPolygon)
        XCTAssertEqual(s.0, 5.0, accuracy: 0.05, "4 m walked + 2 × 0.5 m pad")
        XCTAssertEqual(s.1, 3.5, accuracy: 0.05, "3 m walked + 0.5 m pad; the doorway tap pins the south wall")
        // The raw world corners must still land inside the box when re-projected.
        for p in room.capturedPoints {
            let back = session.floor!.basis.toPlan(p.rawWorld)
            XCTAssertEqual(back.x, p.rawPlan.x, accuracy: 1e-6)
            XCTAssertEqual(back.y, p.rawPlan.y, accuracy: 1e-6)
        }
        XCTAssertEqual(room.walkTrail.count, 6)
        XCTAssertNotNil(room.walkStartedAt)
        XCTAssertNotNil(room.walkEndedAt)
        print("ASSERT: a room walked at 25° to the AR axes is boxed at 4.7×3.7, not inflated")
    }

    func testSecondRoomSharesWallAndDoorway() {
        let session = CaptureSession(name: "Two", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        for p in [(4.0, 0.0), (4.0, 3.0), (0.0, 3.0), (0.0, 0.2)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        // Walk toward the doorway on the east wall and go through.
        mustOK(session.sampleWalk(hit(4.0, 1.5)))
        mustOK(session.throughDoor())
        let kitchen = session.rooms[0]
        XCTAssertEqual(kitchen.name, "Room 1")
        XCTAssertEqual(session.currentRoomLabel, "Room 2", "next room must not inherit the previous name")

        // Next room starts just past the door (inside the kitchen's padding) and is 3.5 m wide.
        for p in [(4.2, 1.5), (4.6, 0.0), (8.0, 0.0), (8.0, 3.0), (4.6, 3.0)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        mustOK(session.throughDoor())
        let hall = session.rooms[1]
        XCTAssertEqual(hall.name, "Room 2")
        XCTAssertEqual(kitchen.displayPolygon.map(\.x).max()!, 4.0, accuracy: 1e-9, "door tap at x=4 pins the kitchen's east wall (no pad there)")
        XCTAssertEqual(kitchen.displayPolygon.map(\.x).min()!, -0.5, accuracy: 1e-9, "west wall padded")
        XCTAssertNotNil(hall.wallSnapShift)
        XCTAssertEqual(hall.displayPolygon.map(\.x).min()!, kitchen.displayPolygon.map(\.x).max()!, accuracy: 1e-9, "shared wall")
        XCTAssertEqual(hall.displayPolygon.map(\.x).max()!, 8.5, accuracy: 1e-9, "far wall keeps its padding")
        XCTAssertEqual(hall.capturedPoints.map(\.rawPlan.x).min()!, 3.7, accuracy: 1e-9, "raw box kept unsnapped")
        XCTAssertTrue(session.mismatches.isEmpty)
        XCTAssertEqual(session.doorways.count, 1)
        let door = session.doorways[0]
        XCTAssertEqual(door.endpointA.x, 4.0, accuracy: 1e-6, "door on the shared wall")
        XCTAssertEqual(door.connectedRoomIDs.count, 2)
        print("ASSERT: second room snaps to the shared wall, keeps raw box, door connects both")
    }

    func testDeepOverlapIsReportedNotHidden() {
        let session = CaptureSession(name: "Overlap", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        for p in [(4.0, 0.0), (4.0, 3.0), (0.0, 3.0)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        mustOK(session.throughDoor())
        // A room walked mostly inside the first one: no snap, mismatch shown.
        for p in [(2.0, 0.5), (7.0, 0.5), (7.0, 2.5), (2.0, 2.5), (5.0, 2.5)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        mustOK(session.throughDoor())
        let second = session.rooms[1]
        XCTAssertNil(second.wallSnapShift)
        XCTAssertEqual(second.displayPolygon.map(\.x).min()!, 1.5, accuracy: 1e-9)
        XCTAssertFalse(session.mismatches.isEmpty, "the disagreement is surfaced")
        print("ASSERT: a 2.7 m overlap is not silently repaired")
    }

    func testRoomIsMeasuredFromTheCameraNotTheCrosshair() {
        let session = CaptureSession(name: "Gate", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        XCTAssertEqual(session.walkSamples.count, 1)

        // Standing at (1, 0), glancing across the room at a panel: ~12° below
        // horizontal, the ray meets the floor plane 7 m out — through the wall.
        mustOK(session.sampleWalk(hit(world: Vec2(x: 8, y: 0), camera: Vec2(x: 1, y: 0))))
        XCTAssertEqual(session.walkSamples.count, 2, "the camera position is the sample")
        XCTAssertEqual(session.walkSamples.last!, Vec2(x: 1, y: 0))
        XCTAssertNil(session.walkPoses.last!.hit, "a shallow ray is not floor evidence")

        // Steep enough but far: 1.5 m up, hit 4.5 m out (dot ≈ 0.32).
        mustOK(session.sampleWalk(hit(world: Vec2(x: 6.5, y: 0), camera: Vec2(x: 2, y: 0))))
        XCTAssertEqual(session.walkSamples.last!, Vec2(x: 2, y: 0))
        XCTAssertNil(session.walkPoses.last!.hit, "a distant hit is not floor evidence")

        // Normal: floor two steps ahead.
        mustOK(session.sampleWalk(hit(world: Vec2(x: 4.8, y: 0), camera: Vec2(x: 3, y: 0))))
        XCTAssertEqual(session.walkPoses.last!.hit, Vec2(x: 4.8, y: 0))
        XCTAssertEqual(session.walkPoses.last!.cameraHeight, 1.5, accuracy: 1e-9)
        XCTAssertNotNil(session.walkPoses.last!.yaw, "phone heading recorded when not pointing straight down")

        // The box follows the camera (0..3 m) plus pad, not the 8 m hit.
        let box = Geometry.roomBox(from: session.walkSamples)
        XCTAssertEqual(box.map(\.x).max()!, 3.5, accuracy: 1e-9)

        // Tracking lost / phone put down: no sample.
        let lost = CameraPose(position: Vec3(x: 9, y: 1.5, z: 0), forward: Vec3(x: 0, y: -1, z: 0), trackingNormal: false)
        mustOK(session.sampleWalk(camera: lost, hit: nil))
        let table = CameraPose(position: Vec3(x: 9, y: 0.4, z: 0), forward: Vec3(x: 0, y: -1, z: 0), trackingNormal: true)
        mustOK(session.sampleWalk(camera: table, hit: nil))
        XCTAssertEqual(session.walkSamples.count, 4)
        print("ASSERT: the room box comes from where the phone was; crosshair hits through walls never widen it")
    }

    func testBeginWalkRejectsTabletopAndOriginFloors() {
        let session = CaptureSession(name: "Table", capabilities: .simulated)
        session.updateTracking(.normal)
        let table = SimulatedHit.downward(x: 0, z: 0, worldY: 1.0, cameraY: 1.5)
        XCTAssertEqual(session.beginWalk(table), .failed(.notTheFloor(cameraHeight: 0.5)))
        XCTAssertNil(session.floor)
        XCTAssertFalse(session.walkRecording)
        // A "hit" at the camera itself (what a missing raycast fallback would give).
        let origin = SimulatedHit.downward(x: 0, z: 0, worldY: 1.5, cameraY: 1.5)
        XCTAssertEqual(session.beginWalk(origin), .failed(.notTheFloor(cameraHeight: 0)))
        mustOK(session.beginWalk(hit(0, 0)))
        XCTAssertNotNil(session.floor)
        print("ASSERT: the floor must be a walking height below the phone")
    }

    func testDoorwayIsPlacedWhereTheBodyIsNotWhereTheAimIs() {
        let session = CaptureSession(name: "Door", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        for p in [(4.0, 0.0), (4.0, 3.0), (2.0, 3.0)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        // Step into the north doorway (the wall is at y = 3.5) looking back into the room (aim y = 1.0).
        mustOK(session.sampleWalk(hit(world: Vec2(x: 2, y: 1.0), camera: Vec2(x: 2, y: 3.5))))
        mustOK(session.throughDoor())
        for p in [(2.0, 3.9), (2.0, 6.0), (0.0, 6.0)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        mustOK(session.throughDoor())
        let door = session.doorways[0]
        XCTAssertEqual(door.endpointA.y, 3.5, accuracy: 1e-6, "on the north wall, exactly where the person stood in the doorway")
        XCTAssertEqual((door.endpointA.x + door.endpointB.x) / 2, 2, accuracy: 1e-6)
        print("ASSERT: doorway uses the camera position, not the crosshair two metres away")
    }

    func testCheckAlignmentUsesTheDoorJustWalkedThrough() {
        let session = CaptureSession(name: "Drift", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        for p in [(4.0, 0.0), (4.0, 3.0), (0.0, 3.0), (4.0, 1.5)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        mustOK(session.throughDoor())   // door A on the east wall at y = 1.5 (still a draft)
        for p in [(4.6, 1.5), (8.0, 1.5), (8.0, 4.0), (4.6, 4.0), (4.6, 1.6)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        // Standing back in door A, tracking says we are 20 cm further east than the door was marked.
        mustOK(session.checkAlignment(cameraPlan: Vec2(x: 4.2, y: 1.5)))
        let check = session.alignmentChecks.last!
        XCTAssertEqual(check.doorwayMidpoint.x, 4.0, accuracy: 1e-6, "door A, not some older door")
        XCTAssertEqual(check.doorwayMidpoint.y, 1.5, accuracy: 1e-6)
        XCTAssertEqual(check.distanceMeters, 0.2, accuracy: 1e-6)
        XCTAssertEqual(session.doorways.count, 1, "the draft was committed once")
        // Finishing the second room still attaches it to that same door.
        mustOK(session.throughDoor())
        XCTAssertEqual(session.doorways.count, 1, "the next door is a draft until room 3 closes")
        XCTAssertNotNil(session.pendingDoorway)
        XCTAssertEqual(session.doorways[0].connectedRoomIDs.count, 2)
        XCTAssertEqual(session.doorways[0].id, check.doorwayID)
        print("ASSERT: return-to-door drift is measured against the door just used")
    }

    func testLiveSettingsReboxRoomsAndOverrideRotatesThePlan() throws {
        let session = CaptureSession(name: "Tune", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        for p in [(4.0, 0.0), (4.0, 3.0), (0.0, 3.0), (0.0, 0.0), (4.0, 1.5)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        mustOK(session.throughDoor())
        for p in [(4.2, 1.5), (4.6, 0.0), (8.0, 0.0), (8.0, 3.0), (4.6, 3.0), (6.0, 3.0)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        mustOK(session.throughDoor())
        XCTAssertEqual(session.rooms[0].displayPolygon.map(\.x).min()!, -0.5, accuracy: 1e-9, "default pad 0.5")
        XCTAssertEqual(session.rooms[0].displayPolygon.map(\.x).max()!, 4.0, accuracy: 1e-9, "door tap pinned")
        XCTAssertEqual(session.rooms[1].displayPolygon.map(\.x).min()!, 4.0, accuracy: 1e-9, "snapped to the kitchen wall")

        // Smaller pad, re-box: both rooms re-derive from stored poses, door pin and snap included.
        var s = session.settings
        s.pad = 0.3
        session.updateSettings(s, reboxRooms: true)
        XCTAssertEqual(session.settings.pad, 0.3)
        XCTAssertEqual(session.rooms[0].displayPolygon.map(\.x).min()!, -0.3, accuracy: 1e-9)
        XCTAssertEqual(session.rooms[0].displayPolygon.map(\.x).max()!, 4.0, accuracy: 1e-9, "pin survives re-box")
        XCTAssertEqual(session.rooms[1].displayPolygon.map(\.x).min()!, 4.0, accuracy: 1e-9, "snap survives re-box")
        XCTAssertEqual(session.rooms[1].displayPolygon.map(\.x).max()!, 8.3, accuracy: 1e-9)
        XCTAssertEqual(session.doorways[0].endpointA.x, 4.0, accuracy: 1e-6, "door still on the shared wall")
        XCTAssertTrue(session.mismatches.isEmpty)

        // Manual grid angle rotates everything consistently; walls stay walls.
        s = session.settings
        s.gridAngleOverride = 10 * .pi / 180
        session.updateSettings(s)
        XCTAssertEqual(session.floor!.gridAngle! * 180 / .pi, 10, accuracy: 1e-9)
        let kitchen = session.rooms[0]
        let expected = Vec2(x: -0.3, y: -0.3).rotated(by: -10 * .pi / 180)
        XCTAssertEqual(kitchen.displayPolygon[0].x, expected.x, accuracy: 1e-9)
        XCTAssertEqual(kitchen.displayPolygon[0].y, expected.y, accuracy: 1e-9)
        for p in kitchen.capturedPoints {
            let back = session.floor!.basis.toPlan(p.rawWorld)
            XCTAssertEqual(back.x, p.rawPlan.x, accuracy: 1e-6, "world ↔ plan stays consistent after override")
            XCTAssertEqual(back.y, p.rawPlan.y, accuracy: 1e-6)
        }
        // Re-boxing in the rotated frame boxes the rotated points (a debug affordance, not magic).
        session.reboxRooms()
        XCTAssertEqual(session.rooms.count, 2)

        // Measuring from hits reproduces the old behaviour on demand.
        s = session.settings
        s.gridAngleOverride = nil
        s.measureFromHits = true
        session.updateSettings(s, reboxRooms: true)
        XCTAssertTrue(session.settings.measureFromHits)

        // Settings and door-tap points survive export.
        let restored = try CaptureSession.fromJSON(session.exportedJSON())
        XCTAssertEqual(restored.settings.pad, 0.3)
        XCTAssertTrue(restored.settings.measureFromHits)
        XCTAssertNotNil(restored.rooms[0].doorTapPoint)
        XCTAssertEqual(restored.rooms[0].walkPoses.count, session.rooms[0].walkPoses.count)
        print("ASSERT: live settings re-box rooms from evidence; manual grid rotates the whole plan; all exported")
    }

    func testLegacyDocumentWithoutSettingsUsesDefaults() throws {
        let json = """
        {"schemaVersion":1,"sessionID":"6C0A5A2E-1E3E-4B9E-9B1D-2B4E7B1E0001","createdAt":1789000000,"name":"Old","appVersion":"0.1.0",
         "deviceCapabilities":{"worldTrackingSupported":false,"lidarDepthSupported":false,"sceneReconstructionSupported":false,"captureMode":"simulated"},
         "rooms":[],"doorways":[],"observations":[],"events":[],"mismatches":[],
         "inProgress":{"phase":"awaitingFloor","points":[]}}
        """
        let session = try CaptureSession.fromJSON(Data(json.utf8))
        XCTAssertEqual(session.settings, .standard)
        XCTAssertNil(session.document.settings)
        print("ASSERT: captures made before settings existed decode with the defaults")
    }

    func testTapeSizeAndRoomTypeRoundTrip() throws {
        let session = CaptureSession(name: "Tape", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        for p in [(4.0, 0.0), (4.0, 3.0), (0.0, 3.0)] { mustOK(session.sampleWalk(hit(p.0, p.1))) }
        session.stopWalkRecording()
        let id = session.rooms[0].id
        mustOK(session.setTapeSize(id: id, width: 4.6, depth: 3.55))
        mustOK(session.setRoomType(id: id, type: .kitchen))
        let restored = try CaptureSession.fromJSON(session.exportedJSON())
        XCTAssertEqual(restored.rooms[0].tapeSize, Vec2(x: 4.6, y: 3.55))
        XCTAssertEqual(restored.rooms[0].type, .kitchen)
        XCTAssertEqual(restored.rooms[0].walkTrail.count, 4)
        XCTAssertEqual(restored.rooms[0].walkPath.count, 4)
        XCTAssertNotNil(restored.floor?.gridAngle)
        mustOK(session.setTapeSize(id: id, width: nil, depth: nil))
        XCTAssertNil(session.rooms[0].tapeSize)
        print("ASSERT: tape measurement and trail survive export; tape never changes geometry")
    }
}
