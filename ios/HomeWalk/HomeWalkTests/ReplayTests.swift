import XCTest
@testable import HomeWalk

final class ReplayTests: XCTestCase {
    private func fixture() -> ReplayFixture {
        let basis = FloorBasis.gravityAligned(origin: Vec3(x: 2, y: -1.4, z: 3), planeID: "source").rotated(byYaw: 0.7)
        let site = SiteRecord(footprintEastNorth: [.init(x: -10, y: -10), .init(x: 10, y: -10), .init(x: 10, y: 10), .init(x: -10, y: 10)], centroidLatitude: 30, centroidLongitude: -100, wallBearingDegrees: 40, areaSquareMeters: 400, source: "test")
        // Sampled in an already-rotated source frame, like the real walk.
        let poses = (0..<60).map { i in
            WalkPose(t: 1000 + Double(i) * 0.35, camera: Vec2(x: Double(i) * 0.12, y: i < 30 ? 0 : 2), hit: nil, cameraHeight: 1.4, yaw: 0)
        }
        return ReplayFixture(schemaVersion: 1, sourceSessionID: UUID(), title: "Fixture", startUnix: 1000, duration: 21,
                             videoDuration: 12, audioDuration: 21, videoOffset: 0, audioOffset: 0,
                             videoTimingEstimated: true, timingNote: "Estimated video anchor",
                             sourceFloor: ConfirmedFloor(basis: basis, confirmedAt: 1000, gridAngle: 0.7),
                             sourceGeo: nil, poses: poses,
                             speech: [.init(t: 1003, startedAt: 1002, text: "This is the breaker panel", isFinal: false),
                                      .init(t: 1016, startedAt: 1015, text: "Here is the water heater", isFinal: true)], site: site)
    }

    func testReplayFeedsEveryPoseThroughCaptureWithOriginalClockAndWorldCoordinates() {
        let f = fixture()
        let replay = ReplayTimeline(fixture: f)
        replay.advance(to: f.duration)
        replay.finish()
        let report = replay.report()
        XCTAssertTrue(report.passed)
        XCTAssertEqual(report.outputPoseCount, 60)
        XCTAssertEqual(report.rooms, 1, "the current capture flow ignores old manual room boundaries")
        XCTAssertEqual(report.manualDoorways, 0)
        XCTAssertEqual(report.maximumWorldPositionErrorMeters, 0, accuracy: 1e-8)
        XCTAssertEqual(report.gridAngleDegrees!, 0.7 * 180 / .pi, accuracy: 1e-6)
        XCTAssertEqual(replay.session.rooms[0].walkPoses.map(\.t), f.poses.map(\.t))
        XCTAssertEqual(replay.session.rooms[0].walkStartedAt, 1000)
        XCTAssertEqual(replay.session.rooms[0].walkEndedAt, 1021)
        XCTAssertNotEqual(replay.session.document.sessionID, f.sourceSessionID)
        XCTAssertEqual(replay.session.document.deviceCapabilities.captureMode, "replay")
        XCTAssertTrue(replay.session.events.contains { $0.type == "replaySource" })
    }

    func testSeekingBackRemovesFutureSpeechAndMatchesUninterruptedReplay() {
        let replay = ReplayTimeline(fixture: fixture())
        replay.advance(to: 18)
        XCTAssertEqual(replay.session.transcript.count, 1)
        XCTAssertTrue(replay.session.checklist.first { $0.title == "Water heater" }!.done)
        replay.advance(to: 2)
        XCTAssertEqual(replay.session.transcript.count, 0)
        XCTAssertTrue(replay.session.capturedItems.isEmpty)
        XCTAssertFalse(replay.session.checklist.first { $0.title == "Water heater" }!.done)
        XCTAssertEqual(replay.consumedPoses, 6)
        replay.advance(to: 21)
        replay.finish()
        let direct = ReplayTimeline(fixture: fixture())
        for t in stride(from: 0.0, through: 21.0, by: 0.25) { direct.advance(to: t) }
        direct.finish()
        XCTAssertEqual(replay.session.rooms[0].editedPolygon, direct.session.rooms[0].editedPolygon)
        XCTAssertEqual(replay.session.rooms[0].walkPoses, direct.session.rooms[0].walkPoses)
        XCTAssertEqual(replay.session.capturedItems.map(\.label), direct.session.capturedItems.map(\.label))
    }

    func testReviewedPlanPreservesRecordingAndSupportsOneStepUndo() throws {
        let replay = ReplayTimeline(fixture: fixture())
        replay.advance(to: 21); replay.finish()
        let original = replay.session.document
        var revised = original
        revised.rooms[0].name = "Kitchen"
        try replay.session.applyReviewedPlan(revised, revision: 1, kind: "correction")
        XCTAssertEqual(replay.session.rooms[0].name, "Kitchen")
        XCTAssertEqual(replay.session.media, original.media)
        XCTAssertEqual(replay.session.rooms[0].walkPoses, original.rooms[0].walkPoses)
        let decoded = try CaptureSession.fromJSON(replay.session.exportedJSON())
        XCTAssertEqual(decoded.document.planReview?.revision, 1)
        _ = replay.session.undo()
        XCTAssertEqual(replay.session.document, original)
        revised.floor?.gridAngle = 2
        XCTAssertThrowsError(try replay.session.applyReviewedPlan(revised, revision: 2, kind: "correction"))
    }

    func testVideoGapDoesNotDiscardPoseAndSpeechTail() {
        let replay = ReplayTimeline(fixture: fixture())
        replay.advance(to: 12)
        let countAtVideoEnd = replay.consumedPoses
        replay.advance(to: 21)
        XCTAssertGreaterThan(replay.consumedPoses, countAtVideoEnd)
        XCTAssertEqual(replay.session.transcript.count, 1)
        replay.finish()
        XCTAssertTrue(replay.report().passed)
        replay.advance(to: 0)
        XCTAssertEqual(replay.session.rooms.count, 0, "restarting a completed replay restores capture state")
        XCTAssertEqual(replay.consumedPoses, 1)
    }
}
