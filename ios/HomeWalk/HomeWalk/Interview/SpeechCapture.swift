import AVFoundation
import Combine
import Foundation
import Speech

/// Records the walk's audio and transcribes it on-device at the same time,
/// from one microphone tap. Partial text streams to the UI as you talk;
/// final segments come with their start/end time so they can be pinned to
/// the room and the video. Recognition is restarted every ~50 s (the
/// framework's per-request limit) without a gap in the audio file.
///
/// Works without speech permission: then it only records.
@MainActor
final class SpeechCapture: ObservableObject {
    @Published private(set) var partialText = ""
    @Published private(set) var listening = false
    @Published private(set) var status = "idle"
    @Published private(set) var recording = false

    /// A finished sentence: text, when it started, when it ended.
    var onFinal: ((String, TimeInterval, TimeInterval) -> Void)?
    /// Text so far for the current sentence.
    var onPartial: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var startedAt: Date?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var segmentStarted: TimeInterval = 0
    private var lastPartial = ""
    private var restartTimer: AnyCancellable?
    private var stopping = false

    static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
    }

    static var speechAuthorized: Bool { SFSpeechRecognizer.authorizationStatus() == .authorized }

    var audioMediaRecord: MediaRecord? {
        guard let fileURL, let startedAt else { return nil }
        var r = MediaRecord()
        r.audioPath = fileURL.lastPathComponent
        r.audioStartedAt = startedAt.timeIntervalSince1970
        r.audioEndedAt = recording ? nil : Date().timeIntervalSince1970
        return r
    }

    /// Start recording to `url` (AAC .m4a) and, if allowed, transcribing.
    func start(fileURL url: URL) throws {
        guard !recording else { return }
        stopping = false
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "SpeechCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "no microphone format"]) }
        try? FileManager.default.removeItem(at: url)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        fileURL = url
        startedAt = Date()

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            // Audio thread: write the file, feed the recognizer. Nothing else.
            try? self.file?.write(from: buffer)
            self.request?.append(buffer)
        }
        engine.prepare()
        try engine.start()
        recording = true
        status = "recording"

        if Self.speechAuthorized {
            beginRecognition()
        } else {
            status = "recording (speech not allowed)"
        }
    }

    private func beginRecognition() {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) ?? SFSpeechRecognizer()
        guard let recognizer, recognizer.isAvailable else { status = "recognizer unavailable"; return }
        self.recognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        request.addsPunctuation = true
        self.request = request
        segmentStarted = Date().timeIntervalSince1970
        lastPartial = ""
        listening = true
        status = recognizer.supportsOnDeviceRecognition ? "listening (on-device)" : "listening (server)"
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self, !self.stopping else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.finish(text: text)
                        self.restartRecognition()
                    } else if text != self.lastPartial {
                        self.lastPartial = text
                        self.partialText = text
                        self.onPartial?(text)
                    }
                }
                if let error {
                    // Silence, cancellation, or the 1-minute limit: start a fresh request.
                    self.status = "listening (restart: \(error.localizedDescription.prefix(40)))"
                    self.finish(text: self.lastPartial)
                    self.restartRecognition(after: 0.8)
                }
            }
        }
        // Hard cap per request so long monologues never hit the framework limit mid-sentence.
        restartTimer?.cancel()
        restartTimer = Timer.publish(every: 50, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            guard let self, self.listening else { return }
            self.request?.endAudio()
        }
    }

    private func finish(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let now = Date().timeIntervalSince1970
        lastPartial = ""
        partialText = ""
        guard !trimmed.isEmpty else { return }
        onFinal?(trimmed, segmentStarted, now)
        segmentStarted = now
    }

    private func restartRecognition(after delay: TimeInterval = 0) {
        guard recording, !stopping else { return }
        task?.cancel()
        task = nil
        request = nil
        listening = false
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.recording, !self.stopping else { return }
            self.beginRecognition()
        }
    }

    /// Stop everything. Returns the audio file URL.
    @discardableResult
    func stop() -> URL? {
        stopping = true
        restartTimer?.cancel()
        if !lastPartial.isEmpty { finish(text: lastPartial) }
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        listening = false
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        file = nil
        recording = false
        status = "stopped"
        return fileURL
    }
}
