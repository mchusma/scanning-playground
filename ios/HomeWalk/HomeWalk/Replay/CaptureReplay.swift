import AVFoundation
import Combine
import SwiftUI

@MainActor
final class CaptureReplay: ObservableObject {
    let directory: URL
    let timeline: ReplayTimeline
    let player: AVPlayer
    var fixture: ReplayFixture { timeline.fixture }
    var session: CaptureSession { timeline.session }
    @Published private(set) var position = 0.0
    @Published private(set) var playing = false
    @Published private(set) var started = false
    @Published private(set) var lastHeard = ""
    @Published var speed: Float = 1
    @Published private(set) var playbackError: String?
    private var observer: Any?
    private var statusObserver: NSKeyValueObservation?
    private var seeking = false
    private var seekID = UUID()

    init(directory: URL) throws {
        self.directory = directory
        let fixture = try ReplayFixture.load(directory: directory)
        timeline = ReplayTimeline(fixture: fixture)
        player = AVPlayer(url: directory.appendingPathComponent("replay.mp4"))
        player.actionAtItemEnd = .pause
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.05, preferredTimescale: 600), queue: .main) { [weak self] time in
            Task { @MainActor in
                guard let self, self.started, !self.seeking, self.playing else { return }
                let seconds = time.seconds
                guard seconds.isFinite else { return }
                // AVPlayer is the single clock for video, audio, and AR poses.
                self.apply(max(self.position, min(seconds, self.fixture.duration)))
                if seconds >= self.fixture.duration - 0.12 {
                    self.apply(self.fixture.duration)
                    self.pause()
                }
            }
        }
        statusObserver = player.currentItem?.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            let message = item.error?.localizedDescription ?? "The replay video could not be opened."
            Task { @MainActor in self?.playbackError = message }
        }
    }

    deinit {
        if let observer { player.removeTimeObserver(observer) }
        statusObserver?.invalidate()
    }

    var videoAvailable: Bool { position >= fixture.videoOffset && position < fixture.videoOffset + fixture.videoDuration }
    var poseCount: Int { timeline.consumedPoses }

    func start() {
        started = true
        timeline.start()
        apply(position)
        play()
    }

    func play() {
        guard !timeline.finished, playbackError == nil else { return }
        if !started { started = true; timeline.start() }
        if position >= fixture.duration - 0.1 { seek(to: 0, resume: true); return }
        playing = true
        player.playImmediately(atRate: speed)
    }

    func pause() {
        playing = false
        player.pause()
    }

    func setSpeed(_ rate: Float) {
        speed = rate
        if playing { player.rate = rate }
    }

    func seek(to seconds: Double, resume: Bool = false) {
        pause()
        seeking = true
        let id = UUID()
        seekID = id
        let target = min(fixture.duration, max(0, seconds))
        started = true
        apply(target)
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.seekID == id else { return }
                self.seeking = false
                if resume { self.play() }
            }
        }
    }

    private func apply(_ seconds: Double) {
        timeline.advance(to: seconds)
        position = seconds
        lastHeard = timeline.latestSpeech
    }

    func finish(store: CaptureStore) throws {
        pause()
        timeline.finish()
        let dir = store.sessionDirectory(id: session.document.sessionID)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for name in [WalkCopy.videoFilename, WalkCopy.audioFilename] {
            let from = directory.appendingPathComponent(name), to = dir.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: from.path), !FileManager.default.fileExists(atPath: to.path) {
                try FileManager.default.copyItem(at: from, to: to)
            }
        }
        var record = MediaRecord()
        record.videoPath = WalkCopy.videoFilename
        record.videoStartedAt = fixture.startUnix + fixture.videoOffset
        record.videoEndedAt = record.videoStartedAt! + fixture.videoDuration
        record.audioPath = WalkCopy.audioFilename
        record.audioStartedAt = fixture.startUnix + fixture.audioOffset
        record.audioEndedAt = record.audioStartedAt! + fixture.audioDuration
        session.setMedia(record)
        store.save(session)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(timeline.report())
        try data.write(to: dir.appendingPathComponent("replay-checks.json"), options: .atomic)
        try data.write(to: directory.appendingPathComponent("last-replay-checks.json"), options: .atomic)
    }
}

struct ReplayVideoView: UIViewRepresentable {
    let player: AVPlayer
    final class Surface: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
    func makeUIView(context: Context) -> Surface {
        let view = Surface()
        view.backgroundColor = .black
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        return view
    }
    func updateUIView(_ uiView: Surface, context: Context) { uiView.playerLayer.player = player }
}

struct ReplayTransportView: View {
    @ObservedObject var replay: CaptureReplay
    @State private var scrubPosition: Double?

    var body: some View {
        VStack(spacing: 5) {
            HStack {
                Text("RECORDED WALK · \(time(replay.position)) / \(time(replay.fixture.duration))")
                    .accessibilityIdentifier("replay-clock")
                Spacer()
                Text("\(replay.poseCount) / \(replay.fixture.poses.count) poses")
                    .accessibilityIdentifier("replay-pose-count")
            }
            .font(.caption2.monospacedDigit().weight(.semibold))
            if !replay.videoAvailable {
                Text("Video unavailable here · recorded audio and ARKit continue")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HWTheme.tape)
                    .accessibilityIdentifier("replay-video-gap")
            }
            if let error = replay.playbackError { Text(error).font(.caption).foregroundStyle(HWTheme.tape) }
            Slider(value: Binding(get: { scrubPosition ?? replay.position }, set: { scrubPosition = $0 }), in: 0...replay.fixture.duration) { editing in
                if editing { replay.pause(); scrubPosition = replay.position }
                else if let value = scrubPosition { replay.seek(to: value); scrubPosition = nil }
            }
            .accessibilityIdentifier("replay-scrubber")
            HStack(spacing: 16) {
                Button { replay.seek(to: 0) } label: { Image(systemName: "backward.end.fill") }
                    .accessibilityLabel("Restart replay").accessibilityIdentifier("replay-restart")
                Button { replay.seek(to: replay.position - 15) } label: { Image(systemName: "gobackward.15") }
                    .accessibilityLabel("Back 15 seconds")
                Button { replay.playing ? replay.pause() : replay.play() } label: { Image(systemName: replay.playing ? "pause.fill" : "play.fill") }
                    .accessibilityLabel(replay.playing ? "Pause replay" : "Play replay").accessibilityIdentifier("replay-play-pause")
                Button { replay.seek(to: replay.position + 15) } label: { Image(systemName: "goforward.15") }
                    .accessibilityLabel("Forward 15 seconds").accessibilityIdentifier("replay-forward")
                Spacer()
                Menu {
                    ForEach([Float(1), 4, 16], id: \.self) { speed in
                        Button("\(Int(speed))×") { replay.setSpeed(speed) }
                    }
                } label: { Text("\(Int(replay.speed))×").font(.callout.weight(.semibold)) }
                .accessibilityLabel("Replay speed").accessibilityIdentifier("replay-speed")
            }
            .font(.system(size: 17))
            .buttonStyle(.plain)
            .frame(minHeight: 30)
        }
        .tint(HWTheme.brass)
        .foregroundStyle(HWTheme.paper)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(HWTheme.navy.opacity(0.97))
    }

    private func time(_ seconds: Double) -> String {
        String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}
