import AVFoundation
import XCTest
@testable import HomeWalk

/// The recorder must produce a playable file whose timeline matches the
/// frames it was given, throttle to its target rate, never block the caller,
/// and report a usable clock anchor. Frames here are synthetic; on the phone
/// they are ARKit's.
final class WalkVideoRecorderTests: XCTestCase {
    private func makeFrame(width: Int, height: Int, shade: UInt8) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, attrs as CFDictionary, &buffer)
        let pb = buffer!
        CVPixelBufferLockBaseAddress(pb, [])
        for plane in 0..<2 {
            let base = CVPixelBufferGetBaseAddressOfPlane(pb, plane)!
            let bytes = CVPixelBufferGetBytesPerRowOfPlane(pb, plane) * CVPixelBufferGetHeightOfPlane(pb, plane)
            memset(base, Int32(plane == 0 ? shade : 128), bytes)
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        return pb
    }

    private func tempURL(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("HomeWalk-\(name)-\(UUID().uuidString).mov")
    }

    private func finish(_ recorder: WalkVideoRecorder, wallClock: TimeInterval) throws -> MediaRecord {
        let done = expectation(description: "finish")
        var outcome: Result<MediaRecord, Error>?
        recorder.stop(wallClock: wallClock) { result in
            outcome = result
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        return try XCTUnwrap(outcome).get()
    }

    func testWritesPlayableMovieWithFrameTimeline() throws {
        let url = tempURL("timeline")
        let recorder = WalkVideoRecorder(targetFPS: 15)
        recorder.arm(url: url)
        XCTAssertTrue(recorder.isArmed)
        XCTAssertFalse(recorder.isRecording, "writer opens on the first frame, not on arm")

        // 2 seconds of frames at exactly 15 fps, AR timestamps starting at an
        // arbitrary monotonic value, wall clock anchored at a known Unix time.
        let t0 = 12_345.678
        let wall0: TimeInterval = 1_800_000_000
        // Paced like the phone: the queue is bounded, so a tight loop would
        // (correctly) drop frames instead of buffering them.
        for i in 0..<30 {
            let frame = makeFrame(width: 320, height: 240, shade: UInt8(min(255, i * 8)))
            recorder.append(frame, timestamp: t0 + Double(i) / 15, wallClock: wall0 + Double(i) / 15)
            usleep(66_000)
        }
        XCTAssertTrue(recorder.isRecording)
        let record = try finish(recorder, wallClock: wall0 + 2)

        XCTAssertEqual(record.videoPath, url.lastPathComponent)
        XCTAssertEqual(record.videoWidth, 320)
        XCTAssertEqual(record.videoHeight, 240)
        XCTAssertEqual(record.videoFrames + record.videoDroppedFrames, 30)
        XCTAssertGreaterThanOrEqual(record.videoFrames, 25, "paced input keeps (nearly) every frame, even with the encoder under load")
        XCTAssertEqual(record.videoStartedAt!, wall0, accuracy: 1e-6, "anchor is the first frame's wall clock")
        XCTAssertEqual(record.videoStartFrameTimestamp!, t0, accuracy: 1e-9)
        XCTAssertEqual(record.unixTime(ofFrameTimestamp: t0 + 1.0)!, wall0 + 1.0, accuracy: 1e-6)
        XCTAssertEqual(record.videoOffset(forUnixTime: wall0 + 1.5)!, 1.5, accuracy: 1e-6)
        XCTAssertNil(record.videoOffset(forUnixTime: wall0 - 1), "before the recording")
        XCTAssertNil(record.videoOffset(forUnixTime: wall0 + 3), "after the recording")

        let asset = AVURLAsset(url: url)
        let duration = try awaitValue { try await asset.load(.duration) }
        XCTAssertEqual(duration.seconds, 2.0, accuracy: 0.35, "30 frames at 15 fps, last frame keeps its duration")
        let tracks = try awaitValue { try await asset.loadTracks(withMediaType: .video) }
        XCTAssertEqual(tracks.count, 1)
        let track = tracks[0]
        let transform = try awaitValue { try await track.load(.preferredTransform) }
        XCTAssertEqual(transform.b, 1, accuracy: 1e-6, "portrait rotation metadata")
        XCTAssertEqual(transform.c, -1, accuracy: 1e-6)
        let size = try awaitValue { try await track.load(.naturalSize) }
        XCTAssertEqual(size.width, 320)
        XCTAssertEqual(size.height, 240)
        print("ASSERT: 30 frames → playable 2 s H.264 movie, portrait metadata, Unix anchor recoverable")
        try? FileManager.default.removeItem(at: url)
    }

    func testThrottlesSixtyHertzToTargetRateAndKeepsGaps() throws {
        let url = tempURL("throttle")
        let recorder = WalkVideoRecorder(targetFPS: 15)
        recorder.arm(url: url)
        let t0 = 100.0
        // One second at 60 Hz, then a 3 s gap (tracking lost), then one more second.
        for i in 0..<60 {
            recorder.append(makeFrame(width: 160, height: 120, shade: 40), timestamp: t0 + Double(i) / 60)
            usleep(16_000)
        }
        for i in 0..<60 {
            recorder.append(makeFrame(width: 160, height: 120, shade: 200), timestamp: t0 + 4 + Double(i) / 60)
            usleep(16_000)
        }
        let record = try finish(recorder, wallClock: 0)
        XCTAssertGreaterThanOrEqual(record.videoFrames, 22)
        XCTAssertLessThanOrEqual(record.videoFrames, 32, "≈15 fps × 2 s, not 120 frames")
        XCTAssertEqual(recorder.stats.throttled + recorder.stats.appended + recorder.stats.dropped, 120)
        let asset = AVURLAsset(url: url)
        let duration = try awaitValue { try await asset.load(.duration) }
        XCTAssertGreaterThan(duration.seconds, 4.8, "the gap stays in the timeline instead of being squeezed out")
        print("ASSERT: 60 Hz input throttled to ~15 fps; a tracking gap is preserved as time")
        try? FileManager.default.removeItem(at: url)
    }

    func testTightLoopDropsInsteadOfQueueing() throws {
        let url = tempURL("backpressure")
        let recorder = WalkVideoRecorder(targetFPS: 15, maxPending: 2)
        recorder.arm(url: url)
        let t0 = 500.0
        for i in 0..<60 {
            recorder.append(makeFrame(width: 640, height: 480, shade: 90), timestamp: t0 + Double(i) / 15)
        }
        let record = try finish(recorder, wallClock: 0)
        XCTAssertEqual(record.videoFrames + record.videoDroppedFrames, 60)
        XCTAssertGreaterThan(record.videoDroppedFrames, 0, "burst beyond the bound is dropped, never buffered")
        XCTAssertGreaterThan(record.videoFrames, 0)
        print("ASSERT: a burst of frames is bounded by dropping, so the AR thread is never blocked")
        try? FileManager.default.removeItem(at: url)
    }

    func testStopWithoutFramesFailsCleanly() {
        let recorder = WalkVideoRecorder()
        recorder.arm(url: tempURL("empty"))
        let done = expectation(description: "stop")
        recorder.stop { result in
            if case .success = result { XCTFail("no frames should not yield a movie") }
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertFalse(recorder.isArmed)
        print("ASSERT: stopping an armed recorder with no frames is an error, not an empty file")
    }

    func testPlaneCopyHandlesStrideDifferences() {
        let src = makeFrame(width: 130, height: 50, shade: 77)
        var dstOpt: CVPixelBuffer?
        CVPixelBufferCreate(nil, 130, 50, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, nil, &dstOpt)
        let dst = dstOpt!
        XCTAssertTrue(WalkVideoRecorder.copyPlanes(from: src, to: dst))
        CVPixelBufferLockBaseAddress(dst, .readOnly)
        let y = CVPixelBufferGetBaseAddressOfPlane(dst, 0)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(dst, 0)
        XCTAssertEqual(y[0], 77)
        XCTAssertEqual(y[49 * stride + 129], 77, "last pixel of the last row")
        CVPixelBufferUnlockBaseAddress(dst, .readOnly)

        var wrongOpt: CVPixelBuffer?
        CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, nil, &wrongOpt)
        XCTAssertFalse(WalkVideoRecorder.copyPlanes(from: src, to: wrongOpt!), "size mismatch refused")
        print("ASSERT: plane copy respects row strides and refuses mismatched buffers")
    }

    func testMediaRecordRoundTripsThroughDocument() throws {
        let session = CaptureSession(name: "Media", capabilities: .simulated)
        session.updateTracking(.normal)
        var video = MediaRecord()
        video.videoPath = "walk-video.mov"
        video.videoStartedAt = 1_800_000_000
        video.videoStartFrameTimestamp = 42
        video.videoEndedAt = 1_800_000_090
        video.videoFrames = 1350
        video.videoWidth = 1920
        video.videoHeight = 1440
        video.videoTargetFPS = 15
        session.setMedia(video)
        var audio = MediaRecord()
        audio.audioPath = "walk-audio.m4a"
        audio.audioStartedAt = 1_799_999_999
        session.setMedia(audio)
        let restored = try CaptureSession.fromJSON(session.exportedJSON())
        let m = try XCTUnwrap(restored.media)
        XCTAssertEqual(m.videoPath, "walk-video.mov")
        XCTAssertEqual(m.videoFrames, 1350)
        XCTAssertEqual(m.audioPath, "walk-audio.m4a")
        XCTAssertEqual(m.audioStartedAt, 1_799_999_999)
        XCTAssertEqual(restored.document.inProgress.videoRelativePath, "walk-video.mov")
        XCTAssertEqual(restored.document.inProgress.audioRelativePath, "walk-audio.m4a")
        print("ASSERT: video and audio timeline anchors merge and survive export")
    }

    func testImmediateAndRepeatedStopDrainsAcceptedFrameAndPersistsStart() throws {
        let url = tempURL("immediate-stop")
        defer { try? FileManager.default.removeItem(at: url) }
        let recorder = WalkVideoRecorder()
        let started = expectation(description: "start anchor")
        recorder.onStarted = { record in
            XCTAssertEqual(record.videoPath, url.lastPathComponent)
            XCTAssertEqual(record.videoStartedAt, 1800000000)
            XCTAssertEqual(record.videoStartFrameTimestamp, 100)
            XCTAssertNil(record.videoEndedAt)
            started.fulfill()
        }
        recorder.arm(url: url)
        recorder.append(makeFrame(width: 160, height: 120, shade: 90), timestamp: 100, wallClock: 1800000000)
        let completed = expectation(description: "both callers finish")
        completed.expectedFulfillmentCount = 2
        for _ in 0..<2 {
            recorder.stop { result in
                do {
                    let record = try result.get()
                    XCTAssertEqual(record.videoFrames, 1, "stop drains the queued frame before clearing the writer")
                    XCTAssertEqual(record.videoEndedAt!, 1800000000 + 1.0 / 15, accuracy: 0.001)
                } catch { XCTFail("\(error)") }
                completed.fulfill()
            }
        }
        wait(for: [started, completed], timeout: 10)
        XCTAssertFalse(recorder.isArmed)
        XCTAssertFalse(recorder.isRecording)
        let again = try finish(recorder, wallClock: 0)
        XCTAssertEqual(again.videoFrames, 1, "a later stop returns the same final record")
        let duration = try awaitValue { try await AVURLAsset(url: url).load(.duration) }
        XCTAssertGreaterThan(duration.seconds, 0)
    }

    @MainActor
    func testRecoveryUsesPlayableDurationAndPreservesOriginalMovie() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = CaptureStore(root: root)
        let session = CaptureSession(name: "Recovery", capabilities: .simulated)
        let dir = store.sessionDirectory(id: session.document.sessionID)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("walk-video.mov")
        let recorder = WalkVideoRecorder()
        recorder.arm(url: url)
        recorder.append(makeFrame(width: 160, height: 120, shade: 90), timestamp: 100, wallClock: 1800000000)
        let final: MediaRecord = try await withCheckedThrowingContinuation { continuation in
            recorder.stop { continuation.resume(with: $0) }
        }
        var interrupted = final
        interrupted.videoEndedAt = nil
        session.setMedia(interrupted)
        store.save(session)
        let original = try Data(contentsOf: url)
        let restored = try store.load(id: session.document.sessionID)
        await store.recoverInterruptedMedia(restored)
        XCTAssertGreaterThan(try XCTUnwrap(restored.media?.videoEndedAt), 1800000000)
        XCTAssertTrue(restored.events.contains { $0.type == "mediaRecovered" })
        XCTAssertEqual(try Data(contentsOf: url), original, "recovery never rewrites the evidence")
        XCTAssertEqual(try store.load(id: session.document.sessionID).media, restored.media)
    }

    // MARK: - helpers

    private func awaitValue<T: Sendable>(_ op: @escaping @Sendable () async throws -> T) throws -> T {
        let done = expectation(description: "async")
        let box = ResultBox<T>()
        Task {
            do { box.result = .success(try await op()) } catch { box.result = .failure(error) }
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        return try XCTUnwrap(box.result).get()
    }

    private final class ResultBox<T>: @unchecked Sendable {
        var result: Result<T, Error>?
    }
}
