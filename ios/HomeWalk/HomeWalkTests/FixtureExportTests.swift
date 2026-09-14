import XCTest
@testable import HomeWalk

/// Writes a representative `.homewalk` bundle for the web review page and the
/// CLI evaluator, so they are tested against the real schema rather than a
/// hand-written imitation. Runs only when `HOMEWALK_FIXTURE_DIR` is set:
///
///   TEST_RUNNER_HOMEWALK_FIXTURE_DIR=/abs/path xcodebuild ... -only-testing:HomeWalkTests/FixtureExportTests test
final class FixtureExportTests: XCTestCase {
    func testWriteSampleBundle() throws {
        guard let dir = ProcessInfo.processInfo.environment["HOMEWALK_FIXTURE_DIR"], !dir.isEmpty else {
            throw XCTSkip("HOMEWALK_FIXTURE_DIR not set")
        }
        let root = URL(fileURLWithPath: dir, isDirectory: true)
        let store = CaptureStore(root: root.appendingPathComponent("store", isDirectory: true))
        let session = CaptureSession(name: "Sample house", capabilities: .simulated)
        session.updateTracking(.normal)
        func hit(_ x: Double, _ z: Double) -> PlacementHit { SimulatedHit.downward(x: x, z: z) }

        // Kitchen 4×3 walked at 20° to the AR axes, with a diagonal to the door.
        let deg = 20.0
        func r(_ x: Double, _ y: Double) -> Vec2 { Vec2(x: x, y: y).rotated(by: deg * .pi / 180) }
        let kitchen = [r(0, 0), r(4, 0), r(4, 3), r(0, 3), r(0, 0.3), r(4, 1.5)]
        XCTAssertTrue(session.beginWalk(hit(kitchen[0].x, kitchen[0].y)).isOK)
        for p in kitchen.dropFirst() { XCTAssertTrue(session.sampleWalk(hit(p.x, p.y)).isOK) }
        session.setWalkRoomName("Kitchen", type: .kitchen)
        XCTAssertTrue(session.throughDoor().isOK)
        let angle = try XCTUnwrap(session.floor?.gridAngle)
        // Hallway east of the kitchen, 1.4 m wide, 6 m long (in the now-aligned frame).
        func a(_ x: Double, _ y: Double) -> Vec2 { Vec2(x: x, y: y).rotated(by: deg * .pi / 180 - angle) }
        _ = a(0, 0)
        for p in [(4.2, 1.5), (4.6, 0.0), (4.6, 6.0), (5.6, 6.0), (5.6, 0.2), (5.7, 4.8)] {
            XCTAssertTrue(session.sampleWalk(hit(r(p.0, p.1).x, r(p.0, p.1).y)).isOK)
        }
        session.setWalkRoomName("Hallway", type: .hallway)
        XCTAssertTrue(session.throughDoor().isOK)
        // Bedroom north-east, 3.6 × 3.4.
        for p in [(5.9, 4.8), (6.2, 3.4), (9.6, 3.4), (9.6, 6.8), (6.2, 6.8), (5.75, 4.8)] {
            XCTAssertTrue(session.sampleWalk(hit(r(p.0, p.1).x, r(p.0, p.1).y)).isOK)
        }
        session.setWalkRoomName("Bedroom", type: .bedroom)
        session.toggleChecklistItem(session.checklist[0].id)
        session.toggleChecklistItem(session.checklist[2].id)
        // Back at the hallway/bedroom door: alignment check with a little drift.
        XCTAssertTrue(session.checkAlignment(cameraPlan: (session.walkPoses.last?.camera ?? .zero) + Vec2(x: 0.12, y: -0.08)).isOK)
        session.stopWalkRecording()

        let rooms = session.rooms
        XCTAssertEqual(rooms.count, 3)
        _ = session.setTapeSize(id: rooms[0].id, width: 4.05, depth: 3.02)
        _ = session.setTapeSize(id: rooms[1].id, width: 1.45, depth: 6.1)
        session.prepareNote(on: rooms[0].id)
        _ = session.answerPrompt(text: "Dishwasher leaks if the top rack is overloaded.")
        var media = MediaRecord()
        media.videoPath = WalkCopy.videoFilename
        media.videoStartedAt = session.events.first!.timestamp
        media.videoStartFrameTimestamp = 1000
        media.videoEndedAt = session.events.last!.timestamp
        media.videoFrames = 900
        media.videoWidth = 1920
        media.videoHeight = 1440
        media.videoTargetFPS = 15
        media.audioPath = WalkCopy.audioFilename
        media.audioStartedAt = session.events.first!.timestamp
        session.setMedia(media)

        let bundle = try store.exportBundle(session: session)
        let dest = root.appendingPathComponent("homewalk-sample.homewalk", isDirectory: true)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.copyItem(at: bundle, to: dest)
        try? FileManager.default.removeItem(at: root.appendingPathComponent("store", isDirectory: true))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appendingPathComponent("plan.json").path))
        print("ASSERT: fixture bundle written to \(dest.path)")
    }
}
