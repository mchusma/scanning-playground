import Foundation

struct ReplayFixture: Codable {
    var schemaVersion: Int
    var sourceSessionID: UUID
    var title: String
    var startUnix: TimeInterval
    var duration: Double
    var videoDuration: Double
    var audioDuration: Double
    var videoOffset: Double
    var audioOffset: Double
    var videoTimingEstimated: Bool
    var timingNote: String
    var sourceFloor: ConfirmedFloor
    var sourceGeo: GeoRecord?
    var poses: [WalkPose]
    var speech: [SpeechEvent]
    var site: SiteRecord

    struct SpeechEvent: Codable {
        var t: TimeInterval
        var startedAt: TimeInterval
        var text: String
        var isFinal: Bool
    }

    static func load(directory: URL) throws -> ReplayFixture {
        let fixture = try JSONDecoder().decode(Self.self, from: Data(contentsOf: directory.appendingPathComponent("fixture.json")))
        guard fixture.schemaVersion == 1, fixture.duration.isFinite, fixture.duration > 0,
              !fixture.poses.isEmpty, fixture.poses.allSatisfy({ $0.t.isFinite && $0.camera.x.isFinite && $0.camera.y.isFinite }),
              zip(fixture.poses, fixture.poses.dropFirst()).allSatisfy({ $0.t < $1.t }) else {
            throw NSError(domain: "Replay", code: 1, userInfo: [NSLocalizedDescriptionKey: "Replay fixture has invalid or unordered poses."])
        }
        return fixture
    }

    /// Stored pose coordinates already include the old capture's final grid
    /// rotation. Reconstruct world coordinates before feeding today's engine.
    func camera(for pose: WalkPose) -> CameraPose {
        let basis = sourceFloor.basis
        let position = basis.toWorld(pose.camera) + basis.yAxis * pose.cameraHeight
        let forward: Vec3
        if let yaw = pose.yaw {
            forward = basis.xAxis * cos(yaw) + basis.zAxis * sin(yaw)
        } else {
            forward = basis.yAxis * -1
        }
        return CameraPose(position: position, forward: forward, trackingNormal: true)
    }

    func hit(for pose: WalkPose) -> PlacementHit? {
        guard let point = pose.hit else { return nil }
        let world = sourceFloor.basis.toWorld(point)
        let camera = camera(for: pose).position
        return PlacementHit(world: world, rayOrigin: camera, rayDirection: (world - camera).normalized(),
                            distance: (world - camera).length, candidatePlaneID: sourceFloor.basis.planeID)
    }
}

/// Deterministic event driver; independent of AVPlayer, wall time, and UI.
final class ReplayTimeline {
    private final class Clock { var value: TimeInterval = 0 }
    private let clock: Clock
    private let seed: CaptureDocument
    let fixture: ReplayFixture
    let session: CaptureSession
    private(set) var position = 0.0
    private(set) var consumedPoses = 0
    private(set) var consumedSpeech = 0
    private(set) var latestSpeech = ""
    private var geoConsumed = false
    private(set) var started = false
    private(set) var finished = false

    init(fixture: ReplayFixture) {
        self.fixture = fixture
        let clock = Clock()
        clock.value = fixture.startUnix
        self.clock = clock
        var caps = DeviceCapabilities.simulated
        caps.captureMode = "replay"
        var seed = CaptureDocument.new(name: "Replay · \(fixture.title)", capabilities: caps)
        seed.createdAt = Date(timeIntervalSince1970: fixture.startUnix)
        seed.floor = ConfirmedFloor(basis: .gravityAligned(origin: fixture.sourceFloor.basis.origin,
                                                         planeID: fixture.sourceFloor.basis.planeID), confirmedAt: fixture.startUnix)
        seed.site = fixture.site
        self.seed = seed
        self.session = CaptureSession(document: seed, clock: { clock.value })
    }

    func start() {
        guard !started else { return }
        started = true
        clock.value = fixture.startUnix
        let origin = fixture.sourceFloor.basis.origin
        let hit = SimulatedHit.downward(x: origin.x, z: origin.z, worldY: origin.y, cameraY: origin.y + 1.5)
        _ = session.beginWalk(hit, sampleInitialPose: false)
        session.setWalkRoomName("Whole walk — awaiting assembly", type: .other)
        session.recordCaptureEvent("replaySource", detail: "\(fixture.sourceSessionID.uuidString); \(fixture.timingNote) Original room taps are not replayed.")
    }

    func reset() {
        session.resetReplay(to: seed)
        position = 0
        consumedPoses = 0
        consumedSpeech = 0
        latestSpeech = ""
        geoConsumed = false
        started = false
        finished = false
        clock.value = fixture.startUnix
    }

    func advance(to seconds: Double) {
        guard seconds.isFinite else { return }
        let target = min(fixture.duration, max(0, seconds))
        if target < position || finished { reset() }
        start()
        let until = fixture.startUnix + target
        while true {
            let poseTime = consumedPoses < fixture.poses.count ? fixture.poses[consumedPoses].t : .infinity
            let speechTime = consumedSpeech < fixture.speech.count ? fixture.speech[consumedSpeech].t : .infinity
            let geoTime = !geoConsumed ? (fixture.sourceGeo?.capturedAt ?? .infinity) : .infinity
            let next = min(poseTime, speechTime, geoTime)
            guard next <= until else { break }
            clock.value = next
            if next == poseTime {
                let pose = fixture.poses[consumedPoses]
                _ = session.sampleWalk(camera: fixture.camera(for: pose), hit: fixture.hit(for: pose))
                consumedPoses += 1
            } else if next == speechTime {
                let speech = fixture.speech[consumedSpeech]
                _ = session.hear(speech.text, isFinal: speech.isFinal, at: speech.t, startedAt: speech.startedAt)
                latestSpeech = speech.text
                consumedSpeech += 1
            } else {
                if var geo = fixture.sourceGeo, let floor = session.floor {
                    geo.cameraPlan = floor.basis.toPlan(fixture.sourceFloor.basis.toWorld(geo.cameraPlan))
                    session.setGeo(geo)
                    session.appendGeoSample(geo)
                }
                geoConsumed = true
            }
        }
        position = target
        clock.value = until
    }

    func finish() {
        guard !finished else { return }
        start()
        session.stopWalkRecording()
        session.recordCaptureEvent("replayFinished", detail: "\(consumedPoses)/\(fixture.poses.count) source poses at \(position) seconds; replay evidence, not a new camera recording")
        finished = true
    }

    struct Report: Codable {
        var sourceSessionID: UUID
        var replaySessionID: UUID
        var sourcePoseCount: Int
        var consumedPoseCount: Int
        var outputPoseCount: Int
        var speechEvents: Int
        var transcriptSegments: Int
        var items: [String]
        var rooms: Int
        var manualDoorways: Int
        var gridAngleDegrees: Double?
        var maximumWorldPositionErrorMeters: Double
        var videoAvailableUntil: Double
        var duration: Double
        var videoTimingEstimated: Bool
        var passed: Bool
    }

    func report() -> Report {
        let output = session.rooms.flatMap(\.walkPoses) + session.walkPoses
        var maxError = 0.0
        if let floor = session.floor {
            for (actual, source) in zip(output, fixture.poses.prefix(consumedPoses)) {
                let world = floor.basis.toWorld(actual.camera) + floor.basis.yAxis * actual.cameraHeight
                maxError = max(maxError, (world - fixture.camera(for: source).position).length)
            }
        }
        return Report(sourceSessionID: fixture.sourceSessionID, replaySessionID: session.document.sessionID,
                      sourcePoseCount: fixture.poses.count, consumedPoseCount: consumedPoses, outputPoseCount: output.count,
                      speechEvents: consumedSpeech, transcriptSegments: session.transcript.count,
                      items: session.capturedItems.map(\.label), rooms: session.rooms.count, manualDoorways: session.doorways.count,
                      gridAngleDegrees: session.floor?.gridAngle.map { $0 * 180 / .pi },
                      maximumWorldPositionErrorMeters: maxError, videoAvailableUntil: fixture.videoOffset + fixture.videoDuration,
                      duration: fixture.duration, videoTimingEstimated: fixture.videoTimingEstimated,
                      passed: finished && consumedPoses == fixture.poses.count && output.count == fixture.poses.count && maxError < 1e-6 && session.rooms.count == 1 && session.doorways.isEmpty)
    }
}
