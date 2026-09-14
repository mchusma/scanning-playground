import Foundation

enum CapturePhase: String, Codable, Equatable {
    case awaitingFloor
    case outliningRoom
    case namingRoom
    case interviewing
    case placingDoorway
    case walking
    case paused
    case reviewing
}

enum TrackingQuality: Equatable {
    case initializing
    case limited(String)
    case normal
    case unavailable
    case interrupted
    case failed(String)

    var allowsPlacement: Bool {
        self == .normal
    }

    var label: String {
        switch self {
        case .initializing: return "Initializing — move slowly"
        case .limited(let reason): return "Tracking limited — \(reason)"
        case .normal: return "Tracking OK"
        case .unavailable: return "World tracking unavailable"
        case .interrupted: return "Tracking interrupted"
        case .failed(let reason): return "Tracking failed — \(reason)"
        }
    }
}

enum RoomType: String, Codable, CaseIterable, Identifiable {
    case kitchen, hallway, bedroom, bathroom, living, dining, other
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .kitchen: return "Kitchen"
        case .hallway: return "Hallway"
        case .bedroom: return "Bedroom"
        case .bathroom: return "Bathroom"
        case .living: return "Living"
        case .dining: return "Dining"
        case .other: return "Other"
        }
    }
}

struct PlacementHit: Equatable {
    var world: Vec3
    var rayOrigin: Vec3
    var rayDirection: Vec3
    var distance: Double
    var candidatePlaneID: String?
}

/// Where the phone is and which way it faces, independent of whether the
/// crosshair is on the floor. This is what a walk is measured from.
struct CameraPose: Equatable {
    var position: Vec3
    /// Unit vector the camera looks along (world).
    var forward: Vec3
    var trackingNormal: Bool
}

enum PlacementError: Equatable, CustomStringConvertible {
    case trackingInadequate
    case noFloor
    case rayNearParallel
    case unreasonableDistance
    case noFloorFound
    case notTheFloor(cameraHeight: Double)
    case floorHeightChanged(meters: Double)
    case duplicatePoint
    case degenerateEdge
    case selfIntersecting
    case tooFewPoints
    case invalidPhase
    case noActiveRoom
    case doorwayNotOnWall
    case invalidDoorway
    case unknownRoom
    case nothingToUndo

    var description: String {
        switch self {
        case .trackingInadequate:
            return "Tracking is not good enough to measure. Notes are still available."
        case .noFloor:
            return "Confirm the floor before adding corners."
        case .rayNearParallel:
            return "Point more toward the floor — the aim is too shallow."
        case .unreasonableDistance:
            return "That hit is too close or too far to trust."
        case .noFloorFound:
            return "No floor under the crosshair yet. Point the phone at the floor a few steps ahead."
        case .notTheFloor(let cameraHeight):
            return String(format: "That surface is only %.0f cm below the phone — a table, not the floor. Aim at the floor.", cameraHeight * 100)
        case .floorHeightChanged(let meters):
            return String(format: "Floor height changed by %.0f cm. Not flattened onto this level.", meters * 100)
        case .duplicatePoint:
            return "That corner is too close to an existing point."
        case .degenerateEdge:
            return "That edge is too short."
        case .selfIntersecting:
            return "That outline crosses itself."
        case .tooFewPoints:
            return "Walk the walls a bit more before finishing this room."
        case .invalidPhase:
            return "That action is not available right now."
        case .noActiveRoom:
            return "No room is active."
        case .doorwayNotOnWall:
            return "Doorway endpoints must sit on a wall edge."
        case .invalidDoorway:
            return "Doorway width or placement is not valid."
        case .unknownRoom:
            return "Unknown room."
        case .nothingToUndo:
            return "Nothing to undo."
        }
    }

    static func from(_ issue: PolygonIssue) -> PlacementError {
        switch issue {
        case .tooFewPoints: return .tooFewPoints
        case .duplicatePoint: return .duplicatePoint
        case .degenerateEdge: return .degenerateEdge
        case .selfIntersecting: return .selfIntersecting
        }
    }
}

enum CaptureResult: Equatable {
    case ok
    case failed(PlacementError)

    var isOK: Bool {
        if case .ok = self { return true }
        return false
    }
}

struct CapturedPoint: Codable, Equatable, Identifiable {
    var id: UUID
    var rawWorld: Vec3
    var rawPlan: Vec2
    var snappedPlan: Vec2
    var isApproximate: Bool
    var wasSnapped: Bool

    func displayPlan(snapEnabled: Bool) -> Vec2 {
        snapEnabled ? snappedPlan : rawPlan
    }
}

struct Room: Codable, Equatable, Identifiable {
    var id: UUID
    var name: String
    var type: RoomType
    var capturedPoints: [CapturedPoint]
    var editedPolygon: [Vec2]
    var revision: Int
    var isApproximate: Bool
    var createdAt: TimeInterval
    /// Floor points the walk box was built from (plan meters). Kept so review can show path vs. box.
    var walkTrail: [Vec2] = []
    /// Camera floor positions during the walk, for drift / audio indexing.
    var walkPath: [Vec2] = []
    /// Every pose sample of the walk (time, camera, hit, height, yaw).
    var walkPoses: [WalkPose] = []
    var walkStartedAt: TimeInterval?
    var walkEndedAt: TimeInterval?
    /// Homeowner's tape measurement (width × depth, meters) for validation. Never used for geometry.
    var tapeSize: Vec2?
    /// Shared-wall snap applied at capture, in meters. The unsnapped box is in `capturedPoints`.
    var wallSnapShift: Double?
    /// Where the person stood when they tapped Through a door (plan metres). Pins that wall.
    var doorTapPoint: Vec2?

    var displayPolygon: [Vec2] {
        editedPolygon
    }

    /// Width × depth of the current polygon's bounds.
    var size: (width: Double, depth: Double)? {
        Geometry.size(of: editedPolygon)
    }

    var sizeLabel: String {
        guard let s = size else { return "" }
        return String(format: "%.1f × %.1f m", s.width, s.depth)
    }

    enum CodingKeys: String, CodingKey {
        case id, name, type, capturedPoints, editedPolygon, revision, isApproximate, createdAt
        case walkTrail, walkPath, walkPoses, walkStartedAt, walkEndedAt, tapeSize, wallSnapShift, doorTapPoint
    }

    init(
        id: UUID,
        name: String,
        type: RoomType,
        capturedPoints: [CapturedPoint],
        editedPolygon: [Vec2],
        revision: Int,
        isApproximate: Bool,
        createdAt: TimeInterval,
        walkTrail: [Vec2] = [],
        walkPath: [Vec2] = [],
        walkPoses: [WalkPose] = [],
        walkStartedAt: TimeInterval? = nil,
        walkEndedAt: TimeInterval? = nil,
        tapeSize: Vec2? = nil,
        wallSnapShift: Double? = nil,
        doorTapPoint: Vec2? = nil
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.capturedPoints = capturedPoints
        self.editedPolygon = editedPolygon
        self.revision = revision
        self.isApproximate = isApproximate
        self.createdAt = createdAt
        self.walkTrail = walkTrail
        self.walkPath = walkPath
        self.walkPoses = walkPoses
        self.walkStartedAt = walkStartedAt
        self.walkEndedAt = walkEndedAt
        self.tapeSize = tapeSize
        self.wallSnapShift = wallSnapShift
        self.doorTapPoint = doorTapPoint
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        type = try c.decode(RoomType.self, forKey: .type)
        capturedPoints = try c.decode([CapturedPoint].self, forKey: .capturedPoints)
        editedPolygon = try c.decode([Vec2].self, forKey: .editedPolygon)
        revision = try c.decode(Int.self, forKey: .revision)
        isApproximate = try c.decode(Bool.self, forKey: .isApproximate)
        createdAt = try c.decode(TimeInterval.self, forKey: .createdAt)
        walkTrail = try c.decodeIfPresent([Vec2].self, forKey: .walkTrail) ?? []
        walkPath = try c.decodeIfPresent([Vec2].self, forKey: .walkPath) ?? []
        walkPoses = try c.decodeIfPresent([WalkPose].self, forKey: .walkPoses) ?? []
        walkStartedAt = try c.decodeIfPresent(TimeInterval.self, forKey: .walkStartedAt)
        walkEndedAt = try c.decodeIfPresent(TimeInterval.self, forKey: .walkEndedAt)
        tapeSize = try c.decodeIfPresent(Vec2.self, forKey: .tapeSize)
        wallSnapShift = try c.decodeIfPresent(Double.self, forKey: .wallSnapShift)
        doorTapPoint = try c.decodeIfPresent(Vec2.self, forKey: .doorTapPoint)
    }
}

/// Tunables for turning a walk into rooms. Stored with the capture so an
/// export says what produced it. Defaults mirror `Geometry`'s constants.
struct CaptureSettings: Codable, Equatable {
    /// Metres from the phone to the wall when walking along it.
    var pad: Double = Geometry.walkPad
    var minSide: Double = 1.2
    /// Debug: box from crosshair hits instead of the camera path (the old behaviour).
    var measureFromHits: Bool = false
    var minRayFloorDot: Double = Geometry.walkMinRayFloorDot
    var maxHitDistance: Double = Geometry.walkMaxHitDistance
    var sharedWallMaxShift: Double = Geometry.sharedWallMaxShift
    var yawMinSamples: Int = 40
    var yawMinInlierFraction: Double = 0.35
    /// Manual wall-grid angle (radians). Nil = automatic.
    var gridAngleOverride: Double?

    static let standard = CaptureSettings()

    enum CodingKeys: String, CodingKey {
        case pad, minSide, measureFromHits, minRayFloorDot, maxHitDistance, sharedWallMaxShift
        case yawMinSamples, yawMinInlierFraction, gridAngleOverride
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = CaptureSettings()
        pad = try c.decodeIfPresent(Double.self, forKey: .pad) ?? d.pad
        minSide = try c.decodeIfPresent(Double.self, forKey: .minSide) ?? d.minSide
        measureFromHits = try c.decodeIfPresent(Bool.self, forKey: .measureFromHits) ?? d.measureFromHits
        minRayFloorDot = try c.decodeIfPresent(Double.self, forKey: .minRayFloorDot) ?? d.minRayFloorDot
        maxHitDistance = try c.decodeIfPresent(Double.self, forKey: .maxHitDistance) ?? d.maxHitDistance
        sharedWallMaxShift = try c.decodeIfPresent(Double.self, forKey: .sharedWallMaxShift) ?? d.sharedWallMaxShift
        yawMinSamples = try c.decodeIfPresent(Int.self, forKey: .yawMinSamples) ?? d.yawMinSamples
        yawMinInlierFraction = try c.decodeIfPresent(Double.self, forKey: .yawMinInlierFraction) ?? d.yawMinInlierFraction
        gridAngleOverride = try c.decodeIfPresent(Double.self, forKey: .gridAngleOverride)
    }
}

/// One walk sample: where the phone was and where its crosshair met the floor.
struct WalkPose: Codable, Equatable {
    var t: TimeInterval
    /// Camera position projected onto the floor (plan meters).
    var camera: Vec2
    /// Crosshair hit on the floor (plan meters), if the crosshair was on it.
    var hit: Vec2?
    var cameraHeight: Double
    /// Heading the phone faces, radians in the plan frame (atan2(y, x)). Nil in the Simulator.
    var yaw: Double?

    init(t: TimeInterval, camera: Vec2, hit: Vec2?, cameraHeight: Double, yaw: Double? = nil) {
        self.t = t
        self.camera = camera
        self.hit = hit
        self.cameraHeight = cameraHeight
        self.yaw = yaw
    }
}

struct Doorway: Codable, Equatable, Identifiable {
    var id: UUID
    var wallRoomID: UUID
    var wallEdgeIndex: Int
    var endpointA: Vec2
    var endpointB: Vec2
    var width: Double
    var connectedRoomIDs: [UUID]
    var evidence: String?
}

struct DoorwayDraft: Codable, Equatable {
    var roomID: UUID
    var edgeIndex: Int
    var endpointA: Vec2
    var endpointB: Vec2
    var width: Double
}

struct Observation: Codable, Equatable, Identifiable {
    enum Source: String, Codable { case typed, spoken, photo }
    enum Status: String, Codable { case confirmed, uncertain }

    var id: UUID
    var roomID: UUID?
    var text: String
    var source: Source
    var status: Status
    var spanningTransition: Bool
    var startedAt: TimeInterval
    var endedAt: TimeInterval
    var audioRelativePath: String?
    var photoRelativePath: String?
}

struct SessionEvent: Codable, Equatable, Identifiable {
    var id: UUID
    var timestamp: TimeInterval
    var type: String
    var entityIDs: [UUID]
    var status: String
    var detail: String
}

struct OutlineMismatch: Codable, Equatable, Identifiable {
    var id: UUID
    var doorwayID: UUID
    var roomA: UUID
    var roomB: UUID
    var distanceMeters: Double
    var angleDegrees: Double
    var summary: String
}

/// Drift evidence: the user returned to a doorway they had marked earlier and
/// tapped Check alignment. Recorded, never used to move geometry.
struct AlignmentCheck: Codable, Equatable, Identifiable {
    var id: UUID
    var timestamp: TimeInterval
    var doorwayID: UUID
    var cameraPlan: Vec2
    var doorwayMidpoint: Vec2
    var distanceMeters: Double
    var trackingState: String
}

struct ChecklistItem: Codable, Equatable, Identifiable {
    var id: UUID
    var category: String
    var title: String
    var done: Bool
    var notes: String
    /// Set when the walker chose to skip it. Cleared if it is later heard or ticked.
    var skippedAt: TimeInterval?
    var doneAt: TimeInterval?
    /// The captured item (heard phrase) that ticked it, if it was automatic.
    var evidenceItemID: UUID?

    var isOpen: Bool { !done && skippedAt == nil }

    var prompt: WalkPrompt? { WalkCopy.prompts.first { $0.title == title } }

    static func standardWalk() -> [ChecklistItem] {
        WalkCopy.prompts.map { ChecklistItem(id: UUID(), category: $0.category, title: $0.title, done: false, notes: "") }
    }
}

struct InterviewPrompt: Codable, Equatable, Identifiable {
    var id: UUID
    var roomID: UUID
    var text: String
    var kind: String

    static func standardRoomPrompts(roomID: UUID) -> [InterviewPrompt] {
        [
            InterviewPrompt(id: UUID(), roomID: roomID, text: "What do you call this room?", kind: "roomName"),
            InterviewPrompt(id: UUID(), roomID: roomID, text: "Anything someone should know about using this room?", kind: "usage"),
            InterviewPrompt(id: UUID(), roomID: roomID, text: "Are there appliances or controls you want to explain?", kind: "appliances"),
            InterviewPrompt(id: UUID(), roomID: roomID, text: "Show the doorway you'll use next.", kind: "nextDoorway")
        ]
    }
}

struct DeviceCapabilities: Codable, Equatable {
    var worldTrackingSupported: Bool
    var lidarDepthSupported: Bool
    var sceneReconstructionSupported: Bool
    var captureMode: String

    static let simulated = DeviceCapabilities(
        worldTrackingSupported: false,
        lidarDepthSupported: false,
        sceneReconstructionSupported: false,
        captureMode: "simulated"
    )
}

struct FloorHeightAlert: Codable, Equatable {
    var meters: Double
    var message: String
}

struct ConfirmedFloor: Codable, Equatable {
    var basis: FloorBasis
    var confirmedAt: TimeInterval
    /// Yaw applied to the basis so the first room's walls are axis-aligned. Nil until the first room closes.
    var gridAngle: Double?
}

struct InProgressState: Codable, Equatable {
    var phase: CapturePhase
    var points: [CapturedPoint]
    var activeRoomID: UUID?
    var lastFinishedRoomID: UUID?
    var pendingDoorway: DoorwayDraft?
    var promptQueue: [InterviewPrompt]
    var recordingStartRoomID: UUID?
    var snapEnabled: Bool
    var floorHeightAlert: FloorHeightAlert?
    var lastError: String?
    var walkSamples: [Vec2]
    var walkRecording: Bool
    var checklist: [ChecklistItem]
    var videoRelativePath: String?
    var audioRelativePath: String?
    var overseerStatus: String
    var accountManagerJoined: Bool
    var walkRoomName: String?
    var walkRoomType: RoomType?
    var walkPoses: [WalkPose]
    var walkRoomStartedAt: TimeInterval?

    static func fresh() -> InProgressState {
        InProgressState(
            phase: .awaitingFloor,
            points: [],
            activeRoomID: nil,
            lastFinishedRoomID: nil,
            pendingDoorway: nil,
            promptQueue: [],
            recordingStartRoomID: nil,
            snapEnabled: false,
            floorHeightAlert: nil,
            lastError: nil,
            walkSamples: [],
            walkRecording: false,
            checklist: ChecklistItem.standardWalk(),
            videoRelativePath: nil,
            audioRelativePath: nil,
            overseerStatus: "guide-listening",
            accountManagerJoined: false,
            walkRoomName: nil,
            walkRoomType: nil,
            walkPoses: [],
            walkRoomStartedAt: nil
        )
    }
}

extension InProgressState {
    enum CodingKeys: String, CodingKey {
        case phase, points, activeRoomID, lastFinishedRoomID, pendingDoorway
        case promptQueue, recordingStartRoomID, snapEnabled, floorHeightAlert, lastError
        case walkSamples, walkRecording, checklist, videoRelativePath, audioRelativePath
        case overseerStatus, accountManagerJoined, walkRoomName, walkRoomType
        case walkPoses, walkRoomStartedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = try c.decode(CapturePhase.self, forKey: .phase)
        points = try c.decode([CapturedPoint].self, forKey: .points)
        activeRoomID = try c.decodeIfPresent(UUID.self, forKey: .activeRoomID)
        lastFinishedRoomID = try c.decodeIfPresent(UUID.self, forKey: .lastFinishedRoomID)
        pendingDoorway = try c.decodeIfPresent(DoorwayDraft.self, forKey: .pendingDoorway)
        promptQueue = try c.decodeIfPresent([InterviewPrompt].self, forKey: .promptQueue) ?? []
        recordingStartRoomID = try c.decodeIfPresent(UUID.self, forKey: .recordingStartRoomID)
        snapEnabled = try c.decodeIfPresent(Bool.self, forKey: .snapEnabled) ?? false
        floorHeightAlert = try c.decodeIfPresent(FloorHeightAlert.self, forKey: .floorHeightAlert)
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        walkSamples = try c.decodeIfPresent([Vec2].self, forKey: .walkSamples) ?? []
        walkRecording = try c.decodeIfPresent(Bool.self, forKey: .walkRecording) ?? false
        checklist = try c.decodeIfPresent([ChecklistItem].self, forKey: .checklist) ?? ChecklistItem.standardWalk()
        videoRelativePath = try c.decodeIfPresent(String.self, forKey: .videoRelativePath)
        audioRelativePath = try c.decodeIfPresent(String.self, forKey: .audioRelativePath)
        overseerStatus = try c.decodeIfPresent(String.self, forKey: .overseerStatus) ?? "guide-listening"
        accountManagerJoined = try c.decodeIfPresent(Bool.self, forKey: .accountManagerJoined) ?? false
        walkRoomName = try c.decodeIfPresent(String.self, forKey: .walkRoomName)
        walkRoomType = try c.decodeIfPresent(RoomType.self, forKey: .walkRoomType)
        walkPoses = try c.decodeIfPresent([WalkPose].self, forKey: .walkPoses) ?? []
        walkRoomStartedAt = try c.decodeIfPresent(TimeInterval.self, forKey: .walkRoomStartedAt)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(phase, forKey: .phase)
        try c.encode(points, forKey: .points)
        try c.encodeIfPresent(activeRoomID, forKey: .activeRoomID)
        try c.encodeIfPresent(lastFinishedRoomID, forKey: .lastFinishedRoomID)
        try c.encodeIfPresent(pendingDoorway, forKey: .pendingDoorway)
        try c.encode(promptQueue, forKey: .promptQueue)
        try c.encodeIfPresent(recordingStartRoomID, forKey: .recordingStartRoomID)
        try c.encode(snapEnabled, forKey: .snapEnabled)
        try c.encodeIfPresent(floorHeightAlert, forKey: .floorHeightAlert)
        try c.encodeIfPresent(lastError, forKey: .lastError)
        try c.encode(walkSamples, forKey: .walkSamples)
        try c.encode(walkRecording, forKey: .walkRecording)
        try c.encode(checklist, forKey: .checklist)
        try c.encodeIfPresent(videoRelativePath, forKey: .videoRelativePath)
        try c.encodeIfPresent(audioRelativePath, forKey: .audioRelativePath)
        try c.encode(overseerStatus, forKey: .overseerStatus)
        try c.encode(accountManagerJoined, forKey: .accountManagerJoined)
        try c.encodeIfPresent(walkRoomName, forKey: .walkRoomName)
        try c.encodeIfPresent(walkRoomType, forKey: .walkRoomType)
        try c.encode(walkPoses, forKey: .walkPoses)
        try c.encodeIfPresent(walkRoomStartedAt, forKey: .walkRoomStartedAt)
    }
}

struct PlanReviewReference: Codable, Equatable {
    var revision: Int
    var kind: String
}

struct CaptureDocument: Codable, Equatable {
    static let currentSchemaVersion = 1
    static let appVersion = "0.1.0"

    var schemaVersion: Int
    var sessionID: UUID
    var createdAt: Date
    var name: String
    var appVersion: String
    var deviceCapabilities: DeviceCapabilities
    var floor: ConfirmedFloor?
    var rooms: [Room]
    var doorways: [Doorway]
    var observations: [Observation]
    var events: [SessionEvent]
    var mismatches: [OutlineMismatch]
    var inProgress: InProgressState
    /// Where the recording sits on the session timeline. Nil until media starts.
    var media: MediaRecord?
    /// Return-to-doorway checks: how far the phone's position was from a
    /// previously marked doorway when the user said they were standing in it.
    var alignmentChecks: [AlignmentCheck] = []
    /// Tunables that produced the rooms. Optional for legacy files; see `effectiveSettings`.
    var settings: CaptureSettings?
    /// GPS fix and compass state at floor confirmation.
    var geo: GeoRecord?
    /// Timestamped location/compass evidence throughout the walk.
    var geoSamples: [GeoRecord] = []
    /// Real building footprint delivered by the Mac, placed on the plan.
    var site: SiteRecord?
    /// Things the walker named, recognised on-device from speech.
    var capturedItems: [CapturedItem] = []
    /// Everything heard, in order, with the room it was said in.
    var transcript: [TranscriptSegment] = []
    var planReview: PlanReviewReference?

    var effectiveSettings: CaptureSettings { settings ?? .standard }

    static func new(name: String, capabilities: DeviceCapabilities) -> CaptureDocument {
        CaptureDocument(
            schemaVersion: currentSchemaVersion,
            sessionID: UUID(),
            createdAt: Date(),
            name: name,
            appVersion: appVersion,
            deviceCapabilities: capabilities,
            floor: nil,
            rooms: [],
            doorways: [],
            observations: [],
            events: [],
            mismatches: [],
            inProgress: .fresh(),
            media: nil,
            alignmentChecks: [],
            settings: .standard
        )
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, sessionID, createdAt, name, appVersion, deviceCapabilities, floor
        case rooms, doorways, observations, events, mismatches, inProgress, media, alignmentChecks, settings, geo, site
        case capturedItems, transcript, geoSamples, planReview
    }

    init(
        schemaVersion: Int, sessionID: UUID, createdAt: Date, name: String, appVersion: String,
        deviceCapabilities: DeviceCapabilities, floor: ConfirmedFloor?, rooms: [Room], doorways: [Doorway],
        observations: [Observation], events: [SessionEvent], mismatches: [OutlineMismatch],
        inProgress: InProgressState, media: MediaRecord?, alignmentChecks: [AlignmentCheck], settings: CaptureSettings?,
        geo: GeoRecord? = nil, site: SiteRecord? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.sessionID = sessionID
        self.createdAt = createdAt
        self.name = name
        self.appVersion = appVersion
        self.deviceCapabilities = deviceCapabilities
        self.floor = floor
        self.rooms = rooms
        self.doorways = doorways
        self.observations = observations
        self.events = events
        self.mismatches = mismatches
        self.inProgress = inProgress
        self.media = media
        self.alignmentChecks = alignmentChecks
        self.settings = settings
        self.geo = geo
        self.site = site
    }

    /// Fields added after the first captures are optional on the way in, so
    /// every plan.json ever written by the app still opens.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decode(Int.self, forKey: .schemaVersion)
        sessionID = try c.decode(UUID.self, forKey: .sessionID)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        name = try c.decode(String.self, forKey: .name)
        appVersion = try c.decode(String.self, forKey: .appVersion)
        deviceCapabilities = try c.decode(DeviceCapabilities.self, forKey: .deviceCapabilities)
        floor = try c.decodeIfPresent(ConfirmedFloor.self, forKey: .floor)
        rooms = try c.decodeIfPresent([Room].self, forKey: .rooms) ?? []
        doorways = try c.decodeIfPresent([Doorway].self, forKey: .doorways) ?? []
        observations = try c.decodeIfPresent([Observation].self, forKey: .observations) ?? []
        events = try c.decodeIfPresent([SessionEvent].self, forKey: .events) ?? []
        mismatches = try c.decodeIfPresent([OutlineMismatch].self, forKey: .mismatches) ?? []
        inProgress = try c.decodeIfPresent(InProgressState.self, forKey: .inProgress) ?? .fresh()
        media = try c.decodeIfPresent(MediaRecord.self, forKey: .media)
        alignmentChecks = try c.decodeIfPresent([AlignmentCheck].self, forKey: .alignmentChecks) ?? []
        settings = try c.decodeIfPresent(CaptureSettings.self, forKey: .settings)
        geo = try c.decodeIfPresent(GeoRecord.self, forKey: .geo)
        geoSamples = try c.decodeIfPresent([GeoRecord].self, forKey: .geoSamples) ?? []
        site = try c.decodeIfPresent(SiteRecord.self, forKey: .site)
        capturedItems = try c.decodeIfPresent([CapturedItem].self, forKey: .capturedItems) ?? []
        transcript = try c.decodeIfPresent([TranscriptSegment].self, forKey: .transcript) ?? []
        planReview = try c.decodeIfPresent(PlanReviewReference.self, forKey: .planReview)
    }

    func room(id: UUID) -> Room? {
        rooms.first { $0.id == id }
    }

    mutating func replaceRoom(_ room: Room) {
        if let idx = rooms.firstIndex(where: { $0.id == room.id }) {
            rooms[idx] = room
        }
    }
}
