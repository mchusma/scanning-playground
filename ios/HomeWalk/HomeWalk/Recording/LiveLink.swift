import Combine
import Foundation

/// What the phone streams to the Mac about once a second while a debug link
/// is open. Small on purpose: tails of the point lists, not the whole walk.
struct LiveSnapshot: Codable {
    struct RoomOut: Codable {
        var id: UUID
        var name: String
        var type: String
        var polygon: [Vec2]
        var tape: Vec2?
        var snap: Double?
    }
    struct DoorOut: Codable {
        var a: Vec2
        var b: Vec2
        var rooms: [UUID]
    }
    struct InProgressOut: Codable {
        var label: String
        var samples: [Vec2]
        var hits: [Vec2]
        var box: [Vec2]
        var size: Vec2?
        var rawSize: Vec2?
        var poseCount: Int
        var lastCameraHeight: Double?
        var lastYawDegrees: Double?
    }
    struct GridOut: Codable {
        var angleDegrees: Double?
        var applied: Double?
        var yawVotes: Int
        var pathMeters: Double
    }
    struct MediaOut: Codable {
        var videoFrames: Int
        var videoDropped: Int
        var recording: Bool
    }
    var type = "snapshot"
    var t: TimeInterval
    var sessionID: UUID
    var name: String
    var tracking: String
    var phase: String
    var walking: Bool
    var settings: CaptureSettings
    var rooms: [RoomOut]
    var doorways: [DoorOut]
    var inProgress: InProgressOut
    var grid: GridOut
    var media: MediaOut
    var checks: [Double]
    var mismatches: [String]
    var prompt: String?
    var promptsDone: Int = 0
    var promptsTotal: Int = 0
    var captured: [String] = []
    var heard: [String] = []
    var footprint: [Vec2]?
    var geo: GeoOut?
    var siteNote: String?

    struct GeoOut: Codable {
        var lat: Double
        var lon: Double
        var accuracy: Double
        var headingAligned: Bool
        var trueHeading: Double?
    }
}

/// A message from the Mac: new settings, or a command.
struct LiveInbound: Codable {
    var type: String
    var settings: CaptureSettings?
    var rebox: Bool?
    var name: String?
}

/// Streams capture snapshots to the Mac dev server over Wi-Fi and applies
/// settings sent back. Debug only; the walk never depends on it, and every
/// failure is just a status string.
@MainActor
final class LiveLink: ObservableObject {
    @Published private(set) var status = "off"
    @Published private(set) var connected = false
    @Published private(set) var sent = 0
    @Published private(set) var received = 0

    var snapshotProvider: (() -> LiveSnapshot?)?
    var onSettings: ((CaptureSettings, Bool) -> Void)?
    var onCommand: ((String) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var host: String?
    private var ticker: AnyCancellable?
    private var retryItem: DispatchWorkItem?
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        return e
    }()

    func connect(host: String) {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { disconnect(); return }
        self.host = trimmed
        open()
    }

    func disconnect() {
        host = nil
        retryItem?.cancel()
        ticker?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        connected = false
        status = "off"
    }

    private func open() {
        guard let host else { return }
        let hostPort = host.contains(":") ? host : "\(host):8787"
        guard let url = URL(string: "ws://\(hostPort)/live?role=phone") else {
            status = "bad address"
            return
        }
        task?.cancel(with: .normalClosure, reason: nil)
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        status = "connecting to \(hostPort)…"
        t.resume()
        receiveLoop(on: t)
        // First send doubles as the connectivity probe.
        sendSnapshot()
        ticker?.cancel()
        ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            self?.sendSnapshot()
        }
    }

    private func scheduleRetry() {
        guard host != nil else { return }
        retryItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.open() }
        retryItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: item)
    }

    private func receiveLoop(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.task === t else { return }
                switch result {
                case .failure(let error):
                    self.connected = false
                    self.status = "lost: \(error.localizedDescription)"
                    self.scheduleRetry()
                case .success(let message):
                    self.connected = true
                    self.status = "live"
                    self.received += 1
                    if case .string(let text) = message, let data = text.data(using: .utf8),
                       let inbound = try? JSONDecoder().decode(LiveInbound.self, from: data)
                    {
                        self.handle(inbound)
                    }
                    self.receiveLoop(on: t)
                }
            }
        }
    }

    private func handle(_ inbound: LiveInbound) {
        switch inbound.type {
        case "settings":
            if let s = inbound.settings { onSettings?(s, inbound.rebox ?? false) }
        case "command":
            if let n = inbound.name { onCommand?(n) }
        default:
            break
        }
    }

    func sendSnapshot() {
        guard let task, let snapshot = snapshotProvider?(), let data = try? encoder.encode(snapshot),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let error {
                    self.connected = false
                    self.status = "send failed: \(error.localizedDescription)"
                    self.scheduleRetry()
                } else {
                    self.sent += 1
                    if !self.connected { self.connected = true; self.status = "live" }
                }
            }
        }
    }
}
