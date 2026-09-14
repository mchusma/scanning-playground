import XCTest
@testable import HomeWalk

final class HomeWalkTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func hit(_ x: Double, _ z: Double, y: Double = 0) -> PlacementHit {
        SimulatedHit.downward(x: x, z: z, worldY: y)
    }

    @discardableResult
    func mustOK(_ result: CaptureResult, _ file: StaticString = #filePath, _ line: UInt = #line) -> Bool {
        if case .failed(let err) = result {
            XCTFail("expected ok, got \(err)", file: file, line: line)
            return false
        }
        return true
    }

    func testTwoRoomCaptureFromEmptySession() throws {
        let session = CaptureSession(name: "Test", capabilities: .simulated)
        session.updateTracking(.normal)

        XCTAssertEqual(session.rooms.count, 0)
        XCTAssertEqual(session.phase, .awaitingFloor)
        XCTAssertEqual(session.instruction, CaptureSession.walkPrompt)
        XCTAssertEqual(session.instruction, WalkCopy.walkPrompt)
        print("ASSERT: empty session starts awaiting floor, walk prompt (no corner tapping)")

        session.updateTracking(.limited("insufficient features"))
        XCTAssertFalse(session.canPlace)
        XCTAssertEqual(session.confirmFloor(hit(0, 0)), .failed(.trackingInadequate))
        XCTAssertNil(session.floor)
        print("ASSERT: poor-tracking blocks placement without wiping the model")

        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        XCTAssertNotNil(session.floor)
        XCTAssertEqual(session.phase, .outliningRoom)

        XCTAssertEqual(session.addCorner(SimulatedHit.shallow(x: 1, z: 1)), .failed(.rayNearParallel))
        print("ASSERT: invalid placement (near-parallel ray) rejected")

        XCTAssertEqual(session.addCorner(hit(1, 0, y: 0.8)), .failed(.floorHeightChanged(meters: 0.8)))
        XCTAssertEqual(session.inProgressPoints.count, 0)
        XCTAssertNotNil(session.floorHeightAlert)
        print("ASSERT: floor-height change reported rather than flattened")

        let kitchen: [(Double, Double)] = [
            (0, 0), (4, 0), (4, 2), (2, 2), (2, 5), (0, 5)
        ]
        for (x, z) in kitchen {
            mustOK(session.addCorner(hit(x, z)))
        }
        XCTAssertEqual(session.inProgressPoints.count, 6)
        XCTAssertEqual(session.inProgressDisplayPolygon.count, 6)
        XCTAssertNotEqual(session.inProgressDisplayPolygon.count, 4)
        print("ASSERT: non-rectangular close")

        let p0 = session.inProgressPoints[0].rawPlan
        XCTAssertEqual(p0.x, 0, accuracy: 1e-9)
        XCTAssertEqual(p0.y, 0, accuracy: 1e-9)
        let p1 = session.inProgressPoints[1].rawPlan
        XCTAssertEqual(p1.x, 4, accuracy: 1e-9)
        XCTAssertEqual(p1.y, 0, accuracy: 1e-9)
        XCTAssertLessThan(abs(p1.x), 50, "plan units are meters, not screen pixels")
        print("ASSERT: floor-basis meters to 2D (not pixels)")

        XCTAssertEqual(session.addCorner(hit(0, 0)), .failed(.duplicatePoint))
        print("ASSERT: rejection of duplicates")

        XCTAssertEqual(session.addCorner(hit(0.01, 5.0)), .failed(.degenerateEdge))
        print("ASSERT: rejection of degenerate edges")

        mustOK(session.undo())
        XCTAssertEqual(session.inProgressPoints.count, 5)
        mustOK(session.addCorner(hit(0, 5)))

        mustOK(session.finishRoom(name: "Kitchen", type: .kitchen))
        XCTAssertEqual(session.rooms.count, 1)
        XCTAssertEqual(session.rooms[0].name, "Kitchen")
        XCTAssertEqual(session.rooms[0].displayPolygon.count, 6)
        XCTAssertEqual(session.phase, .interviewing)
        XCTAssertEqual(session.currentPrompt?.text, "What do you call this room?")
        print("ASSERT: finish room with name/type")

        mustOK(session.answerPrompt(text: "Kitchen"))
        XCTAssertEqual(session.observations.last?.roomID, session.rooms[0].id)
        XCTAssertEqual(session.observations.last?.status, .confirmed)
        XCTAssertEqual(session.currentPrompt?.text, "Anything someone should know about using this room?")
        mustOK(session.skipPrompt())
        XCTAssertEqual(session.currentPrompt?.text, "Are there appliances or controls you want to explain?")
        mustOK(session.answerPrompt(text: "Gas range, left wall"))
        XCTAssertEqual(session.currentPrompt?.text, "Show the doorway you'll use next.")
        mustOK(session.dismissPrompts())
        XCTAssertEqual(session.phase, .placingDoorway)
        print("ASSERT: interview answers attach to the active room")

        let kitchenID = session.rooms[0].id
        mustOK(session.placeDoorwayCenter(
            roomID: kitchenID,
            edgeIndex: 1,
            center: Vec2(x: 4, y: 1),
            width: 0.9
        ))
        XCTAssertNotNil(session.pendingDoorway)
        mustOK(session.enterNewRoom())
        XCTAssertEqual(session.phase, .outliningRoom)
        print("ASSERT: Enter new room")

        for (x, z) in [(4.0, 0.0), (7.0, 0.0), (7.0, 2.0), (4.0, 2.0)] {
            mustOK(session.addCorner(hit(x, z)))
        }
        mustOK(session.finishRoom(name: "Hallway", type: .hallway))
        XCTAssertEqual(session.rooms.count, 2)
        XCTAssertEqual(session.doorways.count, 1)
        let door = try XCTUnwrap(session.doorways.first)
        XCTAssertEqual(door.connectedRoomIDs.count, 2)
        XCTAssertTrue(door.connectedRoomIDs.contains(session.rooms[0].id))
        XCTAssertTrue(door.connectedRoomIDs.contains(session.rooms[1].id))
        print("ASSERT: one shared doorway connecting two rooms")

        mustOK(session.dismissPrompts())
        let hallwayID = session.rooms[1].id
        mustOK(session.placeDoorwayCenter(
            roomID: hallwayID,
            edgeIndex: 1,
            center: Vec2(x: 7, y: 1),
            width: 0.9
        ))
        mustOK(session.returnToExistingRoom(kitchenID))
        XCTAssertEqual(session.phase, .reviewing)
        XCTAssertTrue(session.doorways.contains { $0.connectedRoomIDs.contains(kitchenID) && $0.connectedRoomIDs.contains(hallwayID) })
        print("ASSERT: Return to existing room")

        session.updateTracking(.limited("excessive motion"))
        XCTAssertFalse(session.canPlace)
        let roomsBefore = session.rooms
        let notesBefore = session.observations
        XCTAssertEqual(session.addCorner(hit(8, 0)), .failed(.trackingInadequate))
        XCTAssertEqual(session.rooms, roomsBefore)
        XCTAssertEqual(session.observations, notesBefore)
        print("ASSERT: poor-tracking blocks placement without wiping the model")

        session.updateTracking(.normal)
        mustOK(session.completeSpokenNote(
            text: "and this hallway light is here",
            startedInRoom: kitchenID,
            endedInRoom: hallwayID
        ))
        let spoken = try XCTUnwrap(session.observations.last)
        XCTAssertTrue(spoken.spanningTransition)
        XCTAssertEqual(spoken.status, .uncertain)
        XCTAssertNil(spoken.roomID)
        print("ASSERT: interview answers attach to the active room and transition-spanning speech is uncertain")

        let extruded = session.extrudedFootprints()
        XCTAssertEqual(extruded.count, 2)
        XCTAssertEqual(extruded[0].footprint, session.rooms[0].displayPolygon)
        XCTAssertEqual(extruded[1].footprint, session.rooms[1].displayPolygon)
        print("ASSERT: 3D extrusion uses the same polygon vertices as 2D")

        print("ASSERT: encoding JSON")
        let json = try session.exportedJSON()
        print("ASSERT: encoded JSON bytes \(json.count)")
        let restored = try CaptureSession.fromJSON(json)
        print("ASSERT: decoded JSON rooms=\(restored.rooms.map(\.name)) doors=\(restored.doorways.count) notes=\(restored.observations.count)")
        XCTAssertEqual(restored.rooms.count, 2)
        XCTAssertEqual(restored.rooms[0].name, "Kitchen")
        XCTAssertEqual(restored.rooms[1].name, "Hallway")
        XCTAssertEqual(restored.doorways.count, 2)
        XCTAssertTrue(restored.doorways.contains { $0.connectedRoomIDs.count == 2 })
        XCTAssertEqual(restored.rooms[0].capturedPoints.count, 6)
        XCTAssertEqual(restored.rooms[0].capturedPoints[0].rawPlan.x, 0, accuracy: 1e-6)
        XCTAssertEqual(restored.rooms[0].editedPolygon.count, 6)
        XCTAssertEqual(restored.observations.count, session.observations.count)
        XCTAssertTrue(restored.observations.contains { $0.spanningTransition && $0.status == .uncertain })
        print("ASSERT: JSON round-trip preserves rooms, doorway, notes, and raw vs edited geometry")

        let svg = session.svgString()
        XCTAssertTrue(svg.contains("<polygon"))
        XCTAssertTrue(svg.contains("Kitchen"))
    }

    func testSelfIntersectionRejected() {
        let session = CaptureSession(name: "Bow", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        mustOK(session.addCorner(hit(0, 0)))
        mustOK(session.addCorner(hit(2, 0)))
        mustOK(session.addCorner(hit(0, 1)))
        mustOK(session.addCorner(hit(2, 1)))
        XCTAssertEqual(session.finishRoom(name: "Bad", type: .other), .failed(.selfIntersecting))
        XCTAssertTrue(session.rooms.isEmpty)
        print("ASSERT: rejection of self-intersection")
    }

    func testReversibleSnapKeepsUnsnappedPoints() {
        let session = CaptureSession(name: "Snap", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        session.setSnapEnabled(true)
        mustOK(session.addCorner(hit(0, 0)))
        mustOK(session.addCorner(hit(3, 0)))
        mustOK(session.addCorner(hit(3.2, 2)))
        let point = session.inProgressPoints.last!
        XCTAssertEqual(point.rawPlan.x, 3.2, accuracy: 0.02)
        XCTAssertEqual(point.rawPlan.y, 2.0, accuracy: 0.02)
        XCTAssertEqual(point.snappedPlan.x, 3.0, accuracy: 0.05)
        XCTAssertEqual(point.snappedPlan.y, 2.0, accuracy: 0.05)
        XCTAssertEqual(point.displayPlan(snapEnabled: true).x, point.snappedPlan.x, accuracy: 1e-9)
        session.setSnapEnabled(false)
        XCTAssertFalse(session.snapEnabled)
        XCTAssertEqual(session.inProgressDisplayPolygon.last!.x, point.rawPlan.x, accuracy: 1e-9)
        session.setSnapEnabled(true)
        XCTAssertEqual(session.inProgressDisplayPolygon.last!.x, point.snappedPlan.x, accuracy: 1e-9)
        print("ASSERT: reversible snap with unsnapped points retained")
    }

    func testEditUndoAndPersistence() throws {
        let session = CaptureSession(name: "Persist", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        mustOK(session.addCorner(hit(0, 0)))
        mustOK(session.addCorner(hit(3, 0)))
        mustOK(session.addCorner(hit(3, 2)))
        mustOK(session.addCorner(hit(0, 2)))
        XCTAssertEqual(session.inProgressPoints.count, 4)

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("HomeWalk-\(UUID().uuidString)", isDirectory: true)
        let store = CaptureStore(root: dir)
        store.save(session)
        let loadedMid = try store.load(id: session.document.sessionID)
        XCTAssertEqual(loadedMid.inProgressPoints.count, 4)
        XCTAssertEqual(loadedMid.phase, .outliningRoom)
        print("ASSERT: incomplete capture persistence")

        mustOK(session.finishRoom(name: "Office", type: .other))
        mustOK(session.dismissPrompts())
        let roomID = session.rooms[0].id
        let original = session.rooms[0].editedPolygon[1]
        mustOK(session.adjustCorner(roomID: roomID, index: 1, to: Vec2(x: 3.4, y: 0)))
        XCTAssertEqual(session.rooms[0].editedPolygon[1].x, 3.4, accuracy: 1e-9)
        XCTAssertEqual(session.rooms[0].capturedPoints[1].rawPlan, original)
        mustOK(session.undo())
        XCTAssertEqual(session.rooms[0].editedPolygon[1].x, original.x, accuracy: 1e-9)
        mustOK(session.renameRoom(id: roomID, name: "Study"))
        XCTAssertEqual(session.rooms[0].name, "Study")
        mustOK(session.undo())
        XCTAssertEqual(session.rooms[0].name, "Office")
        print("ASSERT: edit undo")

        store.save(session)
        let bundle = try store.exportBundle(session: session)
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.appendingPathComponent("plan.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.appendingPathComponent("plan.svg").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.appendingPathComponent("manifest.json").path))
    }

    func testMismatchShownNotPatchedWithCorridor() {
        let session = CaptureSession(name: "Gap", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        for (x, z) in [(0.0, 0.0), (3.0, 0.0), (3.0, 2.0), (0.0, 2.0)] {
            mustOK(session.addCorner(hit(x, z)))
        }
        mustOK(session.finishRoom(name: "A", type: .other))
        mustOK(session.dismissPrompts())
        let a = session.rooms[0].id
        mustOK(session.placeDoorwayCenter(roomID: a, edgeIndex: 1, center: Vec2(x: 3, y: 1), width: 0.9))
        mustOK(session.enterNewRoom())
        for (x, z) in [(3.5, 0.0), (6.5, 0.0), (6.5, 2.0), (3.5, 2.0)] {
            mustOK(session.addCorner(hit(x, z)))
        }
        mustOK(session.finishRoom(name: "B", type: .other))
        XCTAssertEqual(session.rooms.count, 2)
        XCTAssertEqual(session.doorways.count, 1)
        XCTAssertFalse(session.rooms.contains { $0.name.lowercased().contains("corridor") })
        XCTAssertFalse(session.mismatches.isEmpty)
        print("ASSERT: adjacent-outline disagreement shown; no corridor invented")
    }

    func testSimulatorAimUsesDraggedMetersNotStaleTextFields() {
        var aim = SimulatorAimState()
        aim.x = 4
        aim.z = 2
        aim.xText = "0.0"
        aim.zText = "0.0"
        let placement = aim.hit()
        XCTAssertTrue(abs(placement.world.x - 4) < 1e-9)
        XCTAssertTrue(abs(placement.world.z - 2) < 1e-9)

        let session = CaptureSession(name: "Aim", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        mustOK(session.addCorner(aim.hit()))
        let plan = session.inProgressPoints.last!.rawPlan
        XCTAssertTrue(abs(plan.x - 4) < 0.02, "expected plan x 4, got \(plan.x)")
        XCTAssertTrue(abs(plan.y - 2) < 0.02, "expected plan y 2, got \(plan.y)")
        print("ASSERT: add corner uses dragged aim, not stale text fields")

        aim.set(x: 1.5, z: -0.5)
        XCTAssertEqual(aim.xText, "1.50")
        XCTAssertEqual(aim.zText, "-0.50")
        aim.xText = "3.25"
        aim.zText = "0.75"
        aim.applyTextFields()
        XCTAssertTrue(abs(aim.x - 3.25) < 1e-9)
        XCTAssertTrue(abs(aim.z - 0.75) < 1e-9)
        XCTAssertTrue(abs(aim.hit().world.x - 3.25) < 1e-9)
    }

    private final class FakeHitSource: PlacementHitSource {
        var next: PlacementHit?
        func currentHit() -> PlacementHit? { next }
        func currentCamera() -> CameraPose? {
            next.map { CameraPose(position: $0.rayOrigin, forward: $0.rayDirection, trackingNormal: true) }
        }
    }

    func testARSourceMissDoesNotFallBackToSimulatorOrigin() {
        let bridge = HitBridge()
        bridge.setSimAim(x: 4, z: 2)

        let simHit = bridge.hit()
        XCTAssertNotNil(simHit)
        XCTAssertTrue(abs((simHit?.world.x ?? 0) - 4) < 1e-9)
        XCTAssertTrue(abs((simHit?.world.z ?? 0) - 2) < 1e-9)

        let source = FakeHitSource()
        source.next = nil
        bridge.source = source
        XCTAssertNil(bridge.hit())
        XCTAssertNil(bridge.camera(), "no camera pose either while the AR source has nothing")
        print("ASSERT: AR source miss rejects instead of placing at simulator origin")

        let session = CaptureSession(name: "ARMiss", capabilities: .simulated)
        session.updateTracking(.normal)
        if let hit = bridge.hit() {
            _ = session.confirmFloor(hit)
        }
        XCTAssertNil(session.floor)
        XCTAssertEqual(session.inProgressPoints.count, 0)

        source.next = SimulatedHit.downward(x: 1.5, z: 0.5)
        let arHit = bridge.hit()
        XCTAssertNotNil(arHit)
        XCTAssertTrue(abs((arHit?.world.x ?? 0) - 1.5) < 1e-9)
        XCTAssertTrue(abs((arHit?.world.z ?? 0) - 0.5) < 1e-9)
        XCTAssertTrue(abs((arHit?.world.x ?? 0) - 4) > 1)
        mustOK(session.confirmFloor(arHit!))
        XCTAssertNotNil(session.floor)
        print("ASSERT: AR source hit is used; simulator aim is ignored while source is attached")
    }

    func testSimulatorFloorMapDragUsesCanvasNotScreen() {
        let map = SimulatorFloorMap(canvasSize: CGSize(width: 400, height: 800))
        let aimed = map.toPlan(CGPoint(x: 400, y: 400))
        XCTAssertEqual(aimed.x, 5, accuracy: 0.05)
        XCTAssertEqual(aimed.y, 0, accuracy: 0.05)
        let back = map.toScreen(aimed)
        XCTAssertEqual(back.x, 400, accuracy: 0.5)
        XCTAssertEqual(back.y, 400, accuracy: 0.5)
        print("ASSERT: simulator floor drag maps canvas coordinates")
    }

    func testReviewCornerDragUsesCanvasCoordinatesNotHandleLocalSpace() {
        let layout = PlanCanvasLayout.fitting(
            points: [Vec2(x: 0, y: 0), Vec2(x: 4, y: 0), Vec2(x: 4, y: 2), Vec2(x: 0, y: 2)],
            canvasSize: CGSize(width: 400, height: 400),
            pad: 1.2
        )
        let vertex = Vec2(x: 4, y: 0)
        let canvasFinger = layout.toScreen(vertex)
        let fromCanvas = layout.toPlan(canvasFinger)
        XCTAssertEqual(fromCanvas.x, 4, accuracy: 0.08)
        XCTAssertEqual(fromCanvas.y, 0, accuracy: 0.08)

        let handleLocal = layout.toPlan(CGPoint(x: 8, y: 8))
        XCTAssertGreaterThan(abs(handleLocal.x - 4) + abs(handleLocal.y - 0), 1.0)

        let dragged = layout.toPlan(CGPoint(x: canvasFinger.x + 40, y: canvasFinger.y))
        XCTAssertGreaterThan(dragged.x, fromCanvas.x + 0.2)

        let session = CaptureSession(name: "Drag", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        for (x, z) in [(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (0.0, 2.0)] {
            mustOK(session.addCorner(hit(x, z)))
        }
        mustOK(session.finishRoom(name: "Office", type: .other))
        mustOK(session.dismissPrompts())
        let roomID = session.rooms[0].id
        mustOK(session.adjustCorner(roomID: roomID, index: 1, to: dragged))
        XCTAssertEqual(session.rooms[0].editedPolygon[1].x, dragged.x, accuracy: 1e-9)
        XCTAssertEqual(session.rooms[0].editedPolygon[1].y, dragged.y, accuracy: 1e-9)
        print("ASSERT: review drag converts canvas finger location, not 16pt handle local space")
    }

    @MainActor
    func testReviewEditsAutosaveThroughAppModelPersist() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("HomeWalk-review-\(UUID().uuidString)", isDirectory: true)
        let store = CaptureStore(root: dir)
        let app = AppModel(store: store, uiTesting: true)
        let session = try XCTUnwrap(app.current)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        for (x, z) in [(0.0, 0.0), (3.0, 0.0), (3.0, 2.0), (0.0, 2.0)] {
            mustOK(session.addCorner(hit(x, z)))
        }
        mustOK(session.finishRoom(name: "Office", type: .other))
        mustOK(session.dismissPrompts())
        let roomID = session.rooms[0].id
        mustOK(session.adjustCorner(roomID: roomID, index: 1, to: Vec2(x: 3.4, y: 0)))
        mustOK(session.renameRoom(id: roomID, name: "Study"))
        session.prepareNote(on: roomID)
        mustOK(session.answerPrompt(text: "North window sticks"))
        app.persist()
        let loaded = try store.load(id: session.document.sessionID)
        XCTAssertEqual(loaded.rooms[0].name, "Study")
        XCTAssertEqual(loaded.rooms[0].editedPolygon[1].x, 3.4, accuracy: 1e-9)
        XCTAssertTrue(loaded.observations.contains { $0.text == "North window sticks" })
        print("ASSERT: review corner/note edits persist via AppModel.persist")
    }

    func testRoomBoxIsPaddedAxisAlignedBounds() {
        let box = Geometry.roomBox(
            from: [Vec2(x: 0, y: 0), Vec2(x: 4, y: 0), Vec2(x: 4, y: 3), Vec2(x: 0, y: 3)],
            pad: 0.35,
            minSide: 1.2
        )
        XCTAssertEqual(box.count, 4)
        let xs = box.map(\.x)
        let ys = box.map(\.y)
        XCTAssertEqual(xs.max()! - xs.min()!, 4.7, accuracy: 1e-9)
        XCTAssertEqual(ys.max()! - ys.min()!, 3.7, accuracy: 1e-9)
        XCTAssertEqual(Geometry.signedArea(box), 4.7 * 3.7, accuracy: 1e-9)

        let tiny = Geometry.roomBox(from: [Vec2(x: 1, y: 1)], pad: 0.35, minSide: 1.2)
        XCTAssertEqual(tiny.count, 4)
        XCTAssertEqual(tiny.map(\.x).max()! - tiny.map(\.x).min()!, 1.2, accuracy: 1e-9)
        XCTAssertEqual(tiny.map(\.y).max()! - tiny.map(\.y).min()!, 1.2, accuracy: 1e-9)
        print("ASSERT: walk room is AABB around pose samples, padded, min side 1.2m")
    }

    func testWalkThroughDoorBuildsApproximateRoomsAndDoorway() throws {
        let session = CaptureSession(name: "Walk", capabilities: .simulated)
        session.updateTracking(.normal)

        mustOK(session.beginWalk(hit(0, 0)))
        XCTAssertEqual(session.phase, .walking)
        XCTAssertTrue(session.walkRecording)
        XCTAssertEqual(session.walkSamples.count, 1, "beginWalk must sample the first pose")
        XCTAssertNotNil(session.floor)
        print("ASSERT: beginWalk confirms floor and records first sample")

        mustOK(session.sampleWalk(hit(4, 0)))
        mustOK(session.sampleWalk(hit(4, 3)))
        mustOK(session.sampleWalk(hit(0, 3)))
        session.setWalkRoomName("Kitchen", type: .kitchen)
        XCTAssertTrue(session.rooms.isEmpty, "naming must not commit the room")
        XCTAssertEqual(session.currentRoomLabel, "Kitchen")
        XCTAssertEqual(session.phase, .walking)

        mustOK(session.throughDoor())
        XCTAssertEqual(session.rooms.count, 1)
        XCTAssertEqual(session.rooms[0].name, "Kitchen")
        XCTAssertEqual(session.rooms[0].type, .kitchen)
        XCTAssertEqual(session.rooms[0].displayPolygon.count, 4)
        XCTAssertTrue(session.rooms[0].isApproximate)
        XCTAssertEqual(session.phase, .walking)
        XCTAssertTrue(session.walkSamples.isEmpty)
        XCTAssertNotNil(session.pendingDoorway, "doorway stays pending until the next room is finished")
        XCTAssertEqual(session.doorways.count, 0)
        let kitchenBox = session.rooms[0].displayPolygon
        // 4 m walked, 0.5 m pad on the far side, and the door tap at (0, 3) pins the near side.
        XCTAssertEqual(kitchenBox.map(\.x).max()! - kitchenBox.map(\.x).min()!, 4.5, accuracy: 0.05)
        print("ASSERT: through-door commits AABB room, drafts doorway, starts next walk")

        mustOK(session.sampleWalk(hit(4.5, 0)))
        mustOK(session.sampleWalk(hit(8, 0)))
        mustOK(session.sampleWalk(hit(8, 3)))
        mustOK(session.sampleWalk(hit(4.5, 3)))
        session.setWalkRoomName("Hallway", type: .hallway)
        mustOK(session.throughDoor())
        XCTAssertEqual(session.rooms.count, 2)
        XCTAssertEqual(session.rooms[1].name, "Hallway")
        XCTAssertEqual(session.doorways.count, 1)
        XCTAssertEqual(session.doorways[0].connectedRoomIDs.count, 2)
        XCTAssertTrue(session.doorways[0].connectedRoomIDs.contains(session.rooms[0].id))
        XCTAssertTrue(session.doorways[0].connectedRoomIDs.contains(session.rooms[1].id))
        print("ASSERT: two walk rooms share one doorway; no corner taps")

        XCTAssertEqual(session.throughDoor(), .failed(.tooFewPoints))
        print("ASSERT: through-door with no new samples is rejected")

        session.toggleChecklistItem(session.checklist[0].id)
        XCTAssertTrue(session.checklist[0].done)
        session.setWalkMedia(video: WalkCopy.videoPlaceholderFilename, audio: WalkCopy.audioFilename)
        session.stopWalkRecording()
        XCTAssertEqual(session.phase, .reviewing)
        XCTAssertFalse(session.walkRecording)

        let json = try session.exportedJSON()
        let restored = try CaptureSession.fromJSON(json)
        XCTAssertEqual(restored.rooms.count, 2)
        XCTAssertEqual(restored.rooms[0].name, "Kitchen")
        XCTAssertEqual(restored.rooms[1].name, "Hallway")
        XCTAssertTrue(restored.rooms[0].isApproximate)
        XCTAssertEqual(restored.doorways.count, 1)
        XCTAssertTrue(restored.checklist[0].done)
        XCTAssertEqual(restored.document.inProgress.videoRelativePath, WalkCopy.videoPlaceholderFilename)
        XCTAssertEqual(restored.document.inProgress.audioRelativePath, WalkCopy.audioFilename)
        print("ASSERT: walk JSON round-trip keeps AABB rooms, doorway, checklist, media placeholders")
    }

    func testResumeCaptureReturnsToWalking() {
        let session = CaptureSession(name: "Resume", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.beginWalk(hit(0, 0)))
        mustOK(session.sampleWalk(hit(2, 0)))
        mustOK(session.sampleWalk(hit(2, 2)))
        session.stopWalkRecording()
        XCTAssertEqual(session.phase, .reviewing)
        XCTAssertEqual(session.rooms.count, 1)
        mustOK(session.resumeCapture())
        XCTAssertEqual(session.phase, .walking)
        XCTAssertTrue(session.walkRecording)
        print("ASSERT: continue capture resumes walk-and-talk, not corner tapping")
    }

    func testLegacyJSONWithoutWalkFieldsStillDecodes() throws {
        let session = CaptureSession(name: "Legacy", capabilities: .simulated)
        session.updateTracking(.normal)
        mustOK(session.confirmFloor(hit(0, 0)))
        for (x, z) in [(0.0, 0.0), (3.0, 0.0), (3.0, 2.0), (0.0, 2.0)] {
            mustOK(session.addCorner(hit(x, z)))
        }
        mustOK(session.finishRoom(name: "Office", type: .other))
        var obj = try JSONSerialization.jsonObject(with: session.exportedJSON()) as! [String: Any]
        var inProgress = obj["inProgress"] as! [String: Any]
        inProgress.removeValue(forKey: "walkSamples")
        inProgress.removeValue(forKey: "walkRecording")
        inProgress.removeValue(forKey: "checklist")
        inProgress.removeValue(forKey: "videoRelativePath")
        inProgress.removeValue(forKey: "audioRelativePath")
        inProgress.removeValue(forKey: "overseerStatus")
        inProgress.removeValue(forKey: "accountManagerJoined")
        inProgress.removeValue(forKey: "walkRoomName")
        inProgress.removeValue(forKey: "walkRoomType")
        obj["inProgress"] = inProgress
        let data = try JSONSerialization.data(withJSONObject: obj)
        let restored = try CaptureSession.fromJSON(data)
        XCTAssertEqual(restored.rooms.count, 1)
        XCTAssertEqual(restored.walkSamples.count, 0)
        XCTAssertEqual(restored.checklist.count, ChecklistItem.standardWalk().count)
        XCTAssertEqual(restored.overseerStatus, "guide-listening")
        print("ASSERT: captures saved before walk fields still load")
    }
}
