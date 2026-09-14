import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

/// Where the walk's media sits on the session timeline. Event timestamps in
/// the document are Unix seconds; video frame times are ARKit's monotonic
/// `ARFrame.timestamp`. `videoStartedAt` + (frameTimestamp − `videoStartFrameTimestamp`)
/// gives the Unix time of any frame, so audio, video and room events can be lined up.
struct MediaRecord: Codable, Equatable {
    var videoPath: String?
    var videoStartedAt: TimeInterval?
    var videoStartFrameTimestamp: Double?
    var videoEndedAt: TimeInterval?
    var videoFrames: Int = 0
    var videoDroppedFrames: Int = 0
    var videoWidth: Int = 0
    var videoHeight: Int = 0
    var videoTargetFPS: Double = 0
    var audioPath: String?
    var audioStartedAt: TimeInterval?
    var audioEndedAt: TimeInterval?

    /// Unix time of a video frame, or nil before recording started.
    func unixTime(ofFrameTimestamp t: Double) -> TimeInterval? {
        guard let start = videoStartedAt, let first = videoStartFrameTimestamp else { return nil }
        return start + (t - first)
    }

    /// Seconds into the video file for a Unix time, or nil if outside the recording.
    func videoOffset(forUnixTime unix: TimeInterval) -> TimeInterval? {
        guard let start = videoStartedAt else { return nil }
        let offset = unix - start
        if offset < 0 { return nil }
        if let end = videoEndedAt, unix > end { return nil }
        return offset
    }
}

/// Encodes ARKit camera frames to an H.264 QuickTime file without ever
/// blocking the AR delegate.
///
/// - `append` copies the frame into a pool buffer and hands it to a serial
///   queue; at most `maxPending` frames wait. Anything beyond that is counted
///   as dropped, not queued. ARKit's own pixel buffers are never retained
///   past the delegate callback.
/// - Frames are throttled to `targetFPS`. Gaps (tracking loss, interruption)
///   appear as gaps in presentation time, not as repeated frames.
/// - The movie is written in fragments so a crash leaves a playable file.
final class WalkVideoRecorder {
    struct Stats: Equatable {
        var appended = 0
        var dropped = 0
        var throttled = 0
    }

    enum RecorderError: Error {
        case notRecording
        case writerFailed(String)
        case noPool
    }

    let targetFPS: Double
    let maxPending: Int
    let portrait: Bool
    private let queue = DispatchQueue(label: "com.orca.homewalk.video", qos: .userInitiated)
    private let lock = NSLock()

    /// Set by `arm(url:)`; the writer opens on the first frame, when the
    /// frame size is known.
    private var armedURL: URL?
    private var stopping = false
    private var stopCallbacks: [(Result<MediaRecord, Error>) -> Void] = []
    private var stoppedResult: Result<MediaRecord, Error>?
    /// First accepted frame supplies the durable video timeline anchor.
    var onStarted: ((MediaRecord) -> Void)?

    var mediaSnapshot: MediaRecord {
        lock.lock()
        defer { lock.unlock() }
        return record
    }
    private var startError: Error?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var pending = 0
    private var startFrameTimestamp: Double?
    private var lastFrameTimestamp: Double?
    private var lastAppendedTimestamp: Double?
    private(set) var stats = Stats()
    private(set) var record = MediaRecord()
    private(set) var fileURL: URL?

    var isRecording: Bool {
        lock.lock()
        defer { lock.unlock() }
        return writer != nil
    }

    var isArmed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !stopping && (armedURL != nil || writer != nil)
    }

    /// Why the writer could not open, if it could not.
    var failure: Error? {
        lock.lock()
        defer { lock.unlock() }
        return startError
    }

    init(targetFPS: Double = 15, maxPending: Int = 2, portrait: Bool = true) {
        self.targetFPS = targetFPS
        self.maxPending = maxPending
        self.portrait = portrait
    }

    /// Record to `url` starting with the next frame. The file's zero is that
    /// first real frame, not the tap on Start walk.
    func arm(url: URL) {
        lock.lock()
        defer { lock.unlock() }
        guard writer == nil, !stopping else { return }
        stoppedResult = nil
        armedURL = url
        startError = nil
    }

    /// Open the writer for a known frame size. Called under `lock`.
    private func openLocked(url: URL, width: Int, height: Int, pixelFormat: OSType) throws {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        writer.movieFragmentInterval = CMTime(seconds: 10, preferredTimescale: 1)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 5_000_000,
                AVVideoExpectedSourceFrameRateKey: Int(targetFPS),
                AVVideoMaxKeyFrameIntervalKey: Int(targetFPS) * 2,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
            ]
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        // ARKit frames are sensor-landscape; the app is portrait. Rotation
        // metadata keeps the pixels untouched and players upright.
        if portrait { input.transform = CGAffineTransform(rotationAngle: .pi / 2) }
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height
            ]
        )
        guard writer.canAdd(input) else { throw RecorderError.writerFailed("cannot add video input") }
        writer.add(input)
        guard writer.startWriting() else {
            throw RecorderError.writerFailed(writer.error?.localizedDescription ?? "startWriting failed")
        }
        self.writer = writer
        self.input = input
        self.adaptor = adaptor
        self.fileURL = url
        self.pending = 0
        self.stats = Stats()
        self.armedURL = nil
        self.startFrameTimestamp = nil
        self.lastFrameTimestamp = nil
        self.lastAppendedTimestamp = nil
        self.record = MediaRecord(
            videoPath: url.lastPathComponent,
            videoWidth: width,
            videoHeight: height,
            videoTargetFPS: targetFPS
        )
    }

    /// Called from the AR delegate. Returns immediately.
    /// `timestamp` is `ARFrame.timestamp` (seconds, monotonic).
    /// `wallClock` should be the Unix time *now*, used only for the first frame's anchor.
    func append(_ source: CVPixelBuffer, timestamp: Double, wallClock: TimeInterval = Date().timeIntervalSince1970) {
        lock.lock()
        guard !stopping else { lock.unlock(); return }
        if writer == nil, let url = armedURL, startError == nil {
            // One-time open on the first frame. A few milliseconds, once.
            do {
                try openLocked(
                    url: url,
                    width: CVPixelBufferGetWidth(source),
                    height: CVPixelBufferGetHeight(source),
                    pixelFormat: CVPixelBufferGetPixelFormatType(source)
                )
            } catch {
                startError = error
                armedURL = nil
            }
        }
        guard let adaptor, let input, writer != nil else {
            lock.unlock()
            return
        }
        // Throttle to targetFPS. A frame counts as due when it is at least
        // one interval (minus a little slack) after the last appended one.
        let interval = 1.0 / targetFPS
        if let last = lastAppendedTimestamp, timestamp - last < interval * 0.9 {
            stats.throttled += 1
            lock.unlock()
            return
        }
        if pending >= maxPending || !input.isReadyForMoreMediaData {
            stats.dropped += 1
            lock.unlock()
            return
        }
        guard let pool = adaptor.pixelBufferPool else {
            stats.dropped += 1
            lock.unlock()
            return
        }
        var copyOpt: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &copyOpt)
        guard let copy = copyOpt, Self.copyPlanes(from: source, to: copy) else {
            stats.dropped += 1
            lock.unlock()
            return
        }
        if startFrameTimestamp == nil {
            startFrameTimestamp = timestamp
            record.videoStartedAt = wallClock
            record.videoStartFrameTimestamp = timestamp
        }
        let first = startFrameTimestamp ?? timestamp
        let presentation = CMTime(seconds: timestamp - first, preferredTimescale: 600)
        let isFirst = lastAppendedTimestamp == nil
        lastAppendedTimestamp = timestamp
        pending += 1
        let initialRecord = record
        let started = onStarted

        // Enqueue under the same lock as stop, so its barrier follows every
        // accepted frame. Retain the recorder until queued work is drained.
        queue.async {
            self.lock.lock()
            let writer = self.writer
            let adaptor = self.adaptor
            self.lock.unlock()
            guard let writer, let adaptor else { return }
            if isFirst {
                writer.startSession(atSourceTime: .zero)
            }
            let ok = adaptor.append(copy, withPresentationTime: presentation)
            self.lock.lock()
            self.pending -= 1
            if ok {
                self.lastFrameTimestamp = timestamp
                self.stats.appended += 1
                self.record.videoFrames = self.stats.appended
            } else {
                self.stats.dropped += 1
            }
            self.record.videoDroppedFrames = self.stats.dropped
            self.lock.unlock()
            if isFirst, ok { started?(initialRecord) }
        }
        lock.unlock()
    }

    /// Stop accepting frames, drain accepted work, then finalize. Multiple
    /// callers share one completion; the writer survives until finalization.
    func stop(wallClock: TimeInterval = Date().timeIntervalSince1970, completion: @escaping (Result<MediaRecord, Error>) -> Void) {
        lock.lock()
        if let result = stoppedResult {
            lock.unlock()
            completion(result)
            return
        }
        stopCallbacks.append(completion)
        if stopping { lock.unlock(); return }
        stopping = true
        armedURL = nil
        queue.async {
            self.lock.lock()
            let writer = self.writer
            let input = self.input
            var record = self.record
            record.videoFrames = self.stats.appended
            record.videoDroppedFrames = self.stats.dropped
            // End at the last accepted frame, not when Done was tapped after
            // a camera interruption. Preserve genuine gaps in the movie.
            if let first = self.startFrameTimestamp, let last = self.lastFrameTimestamp,
               let start = record.videoStartedAt {
                record.videoEndedAt = start + last - first + 1 / self.targetFPS
            }
            let error = self.startError ?? RecorderError.notRecording
            self.lock.unlock()
            guard let writer, let input, record.videoFrames > 0 else {
                writer?.cancelWriting()
                self.completeStop(.failure(error))
                return
            }
            input.markAsFinished()
            writer.finishWriting {
                self.completeStop(writer.status == .completed
                    ? .success(record)
                    : .failure(RecorderError.writerFailed(writer.error?.localizedDescription ?? "finishWriting failed")))
            }
        }
        lock.unlock()
    }

    private func completeStop(_ result: Result<MediaRecord, Error>) {
        lock.lock()
        if case .success(let record) = result { self.record = record }
        writer = nil
        input = nil
        adaptor = nil
        stopping = false
        stoppedResult = result
        let callbacks = stopCallbacks
        stopCallbacks = []
        lock.unlock()
        callbacks.forEach { $0(result) }
    }

    /// Plane-by-plane copy. Handles single-plane and bi-planar formats with
    /// differing row strides.
    static func copyPlanes(from src: CVPixelBuffer, to dst: CVPixelBuffer) -> Bool {
        guard CVPixelBufferGetWidth(src) == CVPixelBufferGetWidth(dst),
              CVPixelBufferGetHeight(src) == CVPixelBufferGetHeight(dst),
              CVPixelBufferGetPixelFormatType(src) == CVPixelBufferGetPixelFormatType(dst)
        else { return false }
        CVPixelBufferLockBaseAddress(src, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(src, .readOnly)
            CVPixelBufferUnlockBaseAddress(dst, [])
        }
        let planes = max(1, CVPixelBufferGetPlaneCount(src))
        for p in 0..<planes {
            let planar = CVPixelBufferIsPlanar(src)
            guard let s = planar ? CVPixelBufferGetBaseAddressOfPlane(src, p) : CVPixelBufferGetBaseAddress(src),
                  let d = planar ? CVPixelBufferGetBaseAddressOfPlane(dst, p) : CVPixelBufferGetBaseAddress(dst)
            else { return false }
            let sStride = planar ? CVPixelBufferGetBytesPerRowOfPlane(src, p) : CVPixelBufferGetBytesPerRow(src)
            let dStride = planar ? CVPixelBufferGetBytesPerRowOfPlane(dst, p) : CVPixelBufferGetBytesPerRow(dst)
            let rows = planar ? CVPixelBufferGetHeightOfPlane(src, p) : CVPixelBufferGetHeight(src)
            let bytes = min(sStride, dStride)
            if sStride == dStride {
                memcpy(d, s, sStride * rows)
            } else {
                for r in 0..<rows {
                    memcpy(d + r * dStride, s + r * sStride, bytes)
                }
            }
        }
        return true
    }
}
