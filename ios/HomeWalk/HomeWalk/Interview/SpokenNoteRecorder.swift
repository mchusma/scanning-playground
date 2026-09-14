import AVFoundation
import Foundation

final class SpokenNoteRecorder: NSObject, AVAudioRecorderDelegate {
    private var recorder: AVAudioRecorder?
    private(set) var fileURL: URL?
    private(set) var startedAt: Date?
    private(set) var endedAt: Date?

    var isRecording: Bool { recorder?.isRecording ?? false }

    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { allowed in
                continuation.resume(returning: allowed)
            }
        }
    }

    func start(in directory: URL, filename: String? = nil) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
        try session.setActive(true)
        let url = directory.appendingPathComponent(filename ?? "note-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.delegate = self
        recorder.record()
        self.recorder = recorder
        self.fileURL = url
        self.startedAt = Date()
        self.endedAt = nil
    }

    func stop() -> URL? {
        guard let recorder else { return nil }
        recorder.stop()
        self.recorder = nil
        endedAt = Date()
        return fileURL
    }

    var mediaRecord: MediaRecord? {
        guard let fileURL, let startedAt else { return nil }
        var r = MediaRecord()
        r.audioPath = fileURL.lastPathComponent
        r.audioStartedAt = startedAt.timeIntervalSince1970
        r.audioEndedAt = endedAt?.timeIntervalSince1970
        return r
    }
}
