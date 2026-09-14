import Foundation
import Combine

/// Testable capture engine. ARKit never appears here: callers pass `PlacementHit`s
/// from a spatial source (device raycast or Simulator-injected meter coordinates).
final class CaptureSession: ObservableObject {
    @Published private(set) var document: CaptureDocument
    @Published private(set) var tracking: TrackingQuality
    @Published var undoDepth: Int = 0

    private var undoStack: [CaptureDocument] = []
    private let maxUndo = 80
    private let clock: () -> TimeInterval

    var phase: CapturePhase { document.inProgress.phase }
    var floor: ConfirmedFloor? { document.floor }
    var rooms: [Room] { document.rooms }
    var doorways: [Doorway] { document.doorways }
    var observations: [Observation] { document.observations }
    var events: [SessionEvent] { document.events }
    var mismatches: [OutlineMismatch] { document.mismatches }
    var inProgressPoints: [CapturedPoint] { document.inProgress.points }
    var snapEnabled: Bool { document.inProgress.snapEnabled }
    var floorHeightAlert: FloorHeightAlert? { document.inProgress.floorHeightAlert }
    var lastError: String? { document.inProgress.lastError }
    var pendingDoorway: DoorwayDraft? { document.inProgress.pendingDoorway }
    var activeRoomID: UUID? { document.inProgress.activeRoomID }
    var lastFinishedRoomID: UUID? { document.inProgress.lastFinishedRoomID }

    var currentPrompt: InterviewPrompt? { document.inProgress.promptQueue.first }

    var canPlace: Bool { tracking.allowsPlacement }

    var currentRoomLabel: String {
        if phase == .walking {
            if let name = document.inProgress.walkRoomName, !name.isEmpty { return name }
            return "Room \(document.rooms.count + 1)"
        }
        if let id = document.inProgress.activeRoomID, let room = document.room(id: id) {
            return room.name
        }
        if phase == .outliningRoom {
            if document.rooms.isEmpty { return "Room 1" }
            return "Room \(document.rooms.count + 1)"
        }
        if let id = document.inProgress.lastFinishedRoomID, let room = document.room(id: id) {
            return room.name
        }
        return "No room yet"
    }

    var instruction: String {
        switch phase {
        case .awaitingFloor:
            return Self.walkPrompt
        case .walking:
            return Self.walkPrompt
        case .outliningRoom:
            return "Aim at a floor/wall corner, then add the corner."
        case .namingRoom:
            return "Name this room."
        case .interviewing:
            return currentPrompt?.text ?? "Answer or skip the question."
        case .placingDoorway:
            return "Mark the doorway on a wall, then enter the next room or return to an existing one."
        case .paused:
            return "Capture paused. Notes stay attached to the current room."
        case .reviewing:
            return "Review the plan. Drag corners to adjust."
        }
    }

    static let floorPrompt = "Move your phone slowly, then point at the floor."
    static let walkPrompt = WalkCopy.walkPrompt

    /// Next uncovered checklist line. The live walk tells you what to cover.
    var liveGuideLine: String {
        if let next = nextPrompt {
            return "Next: \(next.title)"
        }
        return "All prompts covered. Keep talking through the house."
    }

    /// The prompt on screen: first item neither done nor skipped.
    var nextPrompt: ChecklistItem? { checklist.first(where: \.isOpen) }
    var capturedItems: [CapturedItem] { document.capturedItems }
    var transcript: [TranscriptSegment] { document.transcript }

    /// Something was heard. Final segments are stored; both partial and final
    /// text are scanned for items so chips appear the moment a word lands.
    /// Returns the newly captured items (for the UI to celebrate).
    @discardableResult
    func hear(_ text: String, isFinal: Bool, at time: TimeInterval? = nil, startedAt: TimeInterval? = nil) -> [CapturedItem] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let t = time ?? now()
        // While walking, the room has no id yet; items are attached when it closes.
        let roomID: UUID? = phase == .walking ? nil : (document.inProgress.activeRoomID ?? document.inProgress.lastFinishedRoomID)
        var added: [CapturedItem] = []
        for hit in ItemMatcher.match(trimmed) {
            // Same thing named again in the same room within a minute: not a new item.
            if document.capturedItems.contains(where: { $0.label == hit.label && $0.roomID == roomID && t - $0.timestamp < 60 }) { continue }
            let promptsHit = ItemMatcher.prompts(satisfiedBy: hit.phrase, in: WalkCopy.prompts)
            var item = CapturedItem(id: UUID(), label: hit.label, category: hit.category, roomID: roomID, timestamp: t, transcript: trimmed, promptTitle: promptsHit.first?.title)
            for p in promptsHit {
                if let idx = document.inProgress.checklist.firstIndex(where: { $0.title == p.title && !$0.done }) {
                    document.inProgress.checklist[idx].done = true
                    document.inProgress.checklist[idx].doneAt = t
                    document.inProgress.checklist[idx].skippedAt = nil
                    document.inProgress.checklist[idx].evidenceItemID = item.id
                    item.promptTitle = p.title
                    log("promptHeard", detail: p.title)
                }
            }
            document.capturedItems.append(item)
            added.append(item)
            log("itemHeard", entityIDs: [item.id] + (roomID.map { [$0] } ?? []), detail: "\(hit.label): \(trimmed.prefix(80))")
        }
        // Prompts satisfied by a phrase without a vocabulary item ("this room is for…").
        for p in ItemMatcher.prompts(satisfiedBy: trimmed, in: WalkCopy.prompts) {
            if let idx = document.inProgress.checklist.firstIndex(where: { $0.title == p.title && !$0.done }) {
                document.inProgress.checklist[idx].done = true
                document.inProgress.checklist[idx].doneAt = t
                document.inProgress.checklist[idx].skippedAt = nil
                log("promptHeard", detail: p.title)
            }
        }
        if isFinal {
            document.transcript.append(TranscriptSegment(id: UUID(), startedAt: startedAt ?? t, endedAt: t, text: trimmed, roomID: roomID))
        }
        return added
    }

    func skipChecklistItem(_ id: UUID) {
        guard let idx = document.inProgress.checklist.firstIndex(where: { $0.id == id }) else { return }
        document.inProgress.checklist[idx].skippedAt = now()
        log("promptSkipped", detail: document.inProgress.checklist[idx].title)
    }

    func unskipChecklistItem(_ id: UUID) {
        guard let idx = document.inProgress.checklist.firstIndex(where: { $0.id == id }) else { return }
        document.inProgress.checklist[idx].skippedAt = nil
    }

    var walkSamples: [Vec2] { document.inProgress.walkSamples }
    var walkPoses: [WalkPose] { document.inProgress.walkPoses }
    var settings: CaptureSettings { document.effectiveSettings }

    /// Points a room box is built from, per the current settings.
    func boxPoints(for poses: [WalkPose]) -> [Vec2] {
        settings.measureFromHits ? poses.compactMap(\.hit) : poses.map(\.camera)
    }

    /// Live grid estimate and how much evidence backs it, for the debug HUD.
    var gridEstimate: (angleDegrees: Double?, yawVotes: Int, pathMeters: Double) {
        let poses = document.rooms.flatMap(\.walkPoses) + document.inProgress.walkPoses
        let path = document.rooms.flatMap(\.walkTrail) + document.inProgress.walkSamples
        let yaws = poses.compactMap(\.yaw)
        var meters = 0.0
        for i in 1..<max(1, path.count) { meters += path[i].distance(to: path[i - 1]) }
        let angle = Geometry.dominantAngle(yaws: yaws, minSamples: settings.yawMinSamples, minInlierFraction: settings.yawMinInlierFraction)
            ?? Geometry.dominantAngle(of: path)
        return (angle.map { $0 * 180 / .pi }, yaws.count, meters)
    }
    var walkRoomStartedAt: TimeInterval? { document.inProgress.walkRoomStartedAt }
    var gridAligned: Bool { document.floor?.gridAngle != nil }

    /// Width × depth of the room being walked, or nil before any sample.
    var inProgressSize: (width: Double, depth: Double)? {
        guard phase == .walking, !inProgressDisplayPolygon.isEmpty else { return nil }
        return Geometry.size(of: inProgressDisplayPolygon)
    }

    /// Extent of the walked points themselves, before padding. Debug HUD.
    var inProgressRawSize: (width: Double, depth: Double)? {
        guard phase == .walking else { return nil }
        return Geometry.size(of: boxPoints(for: document.inProgress.walkPoses))
    }

    var inProgressSizeLabel: String? {
        guard let s = inProgressSize else { return nil }
        return String(format: "%.1f × %.1f m", s.width, s.depth)
    }
    var checklist: [ChecklistItem] { document.inProgress.checklist }
    var walkRecording: Bool { document.inProgress.walkRecording }
    var overseerStatus: String { document.inProgress.overseerStatus }
    var accountManagerJoined: Bool { document.inProgress.accountManagerJoined }

    var inProgressDisplayPolygon: [Vec2] {
        if phase == .walking {
            let pts = boxPoints(for: document.inProgress.walkPoses)
            if pts.isEmpty { return [] }
            return Geometry.roomBox(from: pts, pad: settings.pad, minSide: settings.minSide)
        }
        return document.inProgress.points.map { $0.displayPlan(snapEnabled: snapEnabled) }
    }

    init(name: String = "Capture", capabilities: DeviceCapabilities = .simulated, clock: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.clock = clock
        self.document = .new(name: name, capabilities: capabilities)
        self.tracking = capabilities.worldTrackingSupported ? .initializing : .normal
    }

    init(document: CaptureDocument, tracking: TrackingQuality = .normal, clock: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.clock = clock
        self.document = document
        self.tracking = tracking
    }

    func updateTracking(_ quality: TrackingQuality) {
        guard tracking != quality else { return }
        tracking = quality
        if walkRecording { log("trackingState", detail: quality.label) }
    }

    func recordCaptureEvent(_ type: String, detail: String) {
        log(type, detail: detail)
    }

    func setSnapEnabled(_ enabled: Bool) {
        pushUndo()
        document.inProgress.snapEnabled = enabled
        log("snap", detail: enabled ? "on" : "off")
    }

    @discardableResult
    func confirmFloor(_ hit: PlacementHit) -> CaptureResult {
        guard canPlace else { return fail(.trackingInadequate) }
        guard phase == .awaitingFloor || document.floor == nil else { return fail(.invalidPhase) }
        if let error = validateRay(hit, floor: nil) { return fail(error) }
        pushUndo()
        let basis = FloorBasis.gravityAligned(origin: hit.world, planeID: hit.candidatePlaneID)
        document.floor = ConfirmedFloor(basis: basis, confirmedAt: now())
        document.inProgress.phase = .outliningRoom
        document.inProgress.lastError = nil
        log("floorConfirmed", detail: "origin meters")
        return .ok
    }

    @discardableResult
    func addCorner(_ hit: PlacementHit, approximate: Bool = false) -> CaptureResult {
        guard canPlace else { return fail(.trackingInadequate) }
        guard phase == .outliningRoom else { return fail(.invalidPhase) }
        guard let floor = document.floor else { return fail(.noFloor) }
        if let error = validateRay(hit, floor: floor.basis) { return fail(error) }

        let height = floor.basis.heightDelta(of: hit.world)
        if height > Geometry.floorHeightWarn {
            let alert = FloorHeightAlert(
                meters: height,
                message: String(format: "Floor height changed by %.0f cm. Not flattened onto this level.", height * 100)
            )
            document.inProgress.floorHeightAlert = alert
            return fail(.floorHeightChanged(meters: height))
        }

        guard let world = intersectFloor(hit, floor: floor.basis) else {
            return fail(.rayNearParallel)
        }
        let rawPlan = floor.basis.toPlan(world)
        let previous = inProgressDisplayPolygon
        if let issue = Geometry.validatePolyline(previous + [rawPlan]) {
            return fail(.from(issue))
        }
        let snapped = Geometry.snapRightAngle(previous: previous, raw: rawPlan)
        var snappedIssueFree = snapped
        if Geometry.validatePolyline(previous + [snapped]) != nil {
            snappedIssueFree = rawPlan
        }
        let point = CapturedPoint(
            id: UUID(),
            rawWorld: world,
            rawPlan: rawPlan,
            snappedPlan: snappedIssueFree,
            isApproximate: approximate,
            wasSnapped: snappedIssueFree.distance(to: rawPlan) >= 0.005
        )
        pushUndo()
        document.inProgress.points.append(point)
        document.inProgress.floorHeightAlert = nil
        document.inProgress.lastError = nil
        log("cornerAdded", detail: approximate ? "approximate" : "measured")
        return .ok
    }

    @discardableResult
    func finishRoom(name: String, type: RoomType) -> CaptureResult {
        guard phase == .outliningRoom || phase == .namingRoom else { return fail(.invalidPhase) }
        let display = inProgressDisplayPolygon
        if let issue = Geometry.validateClosedPolygon(display) {
            return fail(.from(issue))
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let roomName = trimmed.isEmpty ? currentRoomLabel : trimmed
        pushUndo()
        let room = Room(
            id: UUID(),
            name: roomName,
            type: type,
            capturedPoints: document.inProgress.points,
            editedPolygon: display,
            revision: 1,
            isApproximate: document.inProgress.points.contains(where: \.isApproximate),
            createdAt: now()
        )
        document.rooms.append(room)
        if let pending = document.inProgress.pendingDoorway {
            attach(roomID: room.id, toPending: pending)
        } else if let doorID = unmatchedDoorwayID() {
            if let idx = document.doorways.firstIndex(where: { $0.id == doorID }) {
                if !document.doorways[idx].connectedRoomIDs.contains(room.id) {
                    document.doorways[idx].connectedRoomIDs.append(room.id)
                    evaluateMismatch(doorwayIndex: idx)
                }
            }
        }
        document.inProgress.points = []
        document.inProgress.activeRoomID = room.id
        document.inProgress.lastFinishedRoomID = room.id
        document.inProgress.promptQueue = InterviewPrompt.standardRoomPrompts(roomID: room.id)
        document.inProgress.phase = .interviewing
        document.inProgress.lastError = nil
        log("roomFinished", entityIDs: [room.id], detail: room.name)
        return .ok
    }

    @discardableResult
    func placeDoorwayOnEdge(roomID: UUID, edgeIndex: Int, endpointA: Vec2, endpointB: Vec2) -> CaptureResult {
        guard let room = document.room(id: roomID) else { return fail(.unknownRoom) }
        let poly = room.displayPolygon
        guard let a = Geometry.pointOnEdge(endpointA, polygon: poly, edgeIndex: edgeIndex),
              let b = Geometry.pointOnEdge(endpointB, polygon: poly, edgeIndex: edgeIndex)
        else { return fail(.doorwayNotOnWall) }
        let width = a.point.distance(to: b.point)
        if width < Geometry.pointEpsilon { return fail(.invalidDoorway) }
        pushUndo()
        document.inProgress.pendingDoorway = DoorwayDraft(
            roomID: roomID,
            edgeIndex: edgeIndex,
            endpointA: a.point,
            endpointB: b.point,
            width: width
        )
        document.inProgress.phase = .placingDoorway
        document.inProgress.lastError = nil
        log("doorwayDraft", entityIDs: [roomID], detail: "twoEndpoints")
        return .ok
    }

    @discardableResult
    func placeDoorwayCenter(roomID: UUID, edgeIndex: Int, center: Vec2, width: Double) -> CaptureResult {
        guard let room = document.room(id: roomID) else { return fail(.unknownRoom) }
        let poly = room.displayPolygon
        guard let onEdge = Geometry.pointOnEdge(center, polygon: poly, edgeIndex: edgeIndex) else {
            return fail(.doorwayNotOnWall)
        }
        guard let pair = Geometry.doorwayFromCenter(
            polygon: poly,
            edgeIndex: edgeIndex,
            centerT: onEdge.t,
            width: width
        ) else { return fail(.invalidDoorway) }
        return placeDoorwayOnEdge(roomID: roomID, edgeIndex: edgeIndex, endpointA: pair.0, endpointB: pair.1)
    }

    @discardableResult
    func enterNewRoom() -> CaptureResult {
        guard phase == .placingDoorway || phase == .interviewing else { return fail(.invalidPhase) }
        guard let draft = document.inProgress.pendingDoorway else { return fail(.invalidDoorway) }
        pushUndo()
        commitDraftIfNeeded(draft)
        document.inProgress.points = []
        document.inProgress.activeRoomID = nil
        document.inProgress.promptQueue = []
        document.inProgress.phase = .outliningRoom
        document.inProgress.lastError = nil
        log("enterNewRoom", entityIDs: [draft.roomID], detail: "sharedDoorway")
        return .ok
    }

    @discardableResult
    func returnToExistingRoom(_ roomID: UUID) -> CaptureResult {
        guard document.room(id: roomID) != nil else { return fail(.unknownRoom) }
        guard let draft = document.inProgress.pendingDoorway else { return fail(.invalidDoorway) }
        pushUndo()
        let doorID = commitDraftIfNeeded(draft)
        if let idx = document.doorways.firstIndex(where: { $0.id == doorID }) {
            if !document.doorways[idx].connectedRoomIDs.contains(roomID) {
                document.doorways[idx].connectedRoomIDs.append(roomID)
            }
            evaluateMismatch(doorwayIndex: idx)
        }
        document.inProgress.activeRoomID = roomID
        document.inProgress.phase = .reviewing
        document.inProgress.lastError = nil
        log("returnToExistingRoom", entityIDs: [roomID], detail: "sharedDoorway")
        return .ok
    }

    @discardableResult
    func answerPrompt(text: String?, audioRelativePath: String? = nil, photoRelativePath: String? = nil) -> CaptureResult {
        guard phase == .interviewing || phase == .paused else { return fail(.invalidPhase) }
        guard let prompt = currentPrompt else { return fail(.invalidPhase) }
        let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let startRoom = document.inProgress.recordingStartRoomID ?? prompt.roomID
        let endRoom = document.inProgress.activeRoomID ?? prompt.roomID
        let spanning = startRoom != endRoom
        let source: Observation.Source
        if audioRelativePath != nil { source = .spoken }
        else if photoRelativePath != nil && trimmed.isEmpty { source = .photo }
        else { source = .typed }
        pushUndo()
        let observation = Observation(
            id: UUID(),
            roomID: spanning ? nil : endRoom,
            text: trimmed,
            source: source,
            status: spanning ? .uncertain : .confirmed,
            spanningTransition: spanning,
            startedAt: now(),
            endedAt: now(),
            audioRelativePath: audioRelativePath,
            photoRelativePath: photoRelativePath
        )
        document.observations.append(observation)
        if prompt.kind == "roomName", !trimmed.isEmpty, !spanning,
           var room = document.room(id: prompt.roomID)
        {
            room.name = trimmed
            room.revision += 1
            document.replaceRoom(room)
        }
        document.inProgress.recordingStartRoomID = nil
        advancePromptLocked()
        log("observation", entityIDs: [prompt.roomID], detail: spanning ? "uncertain" : "confirmed")
        return .ok
    }

    @discardableResult
    func skipPrompt() -> CaptureResult {
        guard phase == .interviewing || phase == .paused else { return fail(.invalidPhase) }
        guard currentPrompt != nil else { return fail(.invalidPhase) }
        pushUndo()
        advancePromptLocked()
        return .ok
    }

    @discardableResult
    func dismissPrompts() -> CaptureResult {
        guard phase == .interviewing || phase == .paused else { return fail(.invalidPhase) }
        pushUndo()
        document.inProgress.promptQueue = []
        document.inProgress.phase = document.rooms.isEmpty ? .outliningRoom : .placingDoorway
        return .ok
    }

    /// Spoken note that may start in one room and end in another.
    @discardableResult
    func completeSpokenNote(text: String, startedInRoom: UUID?, endedInRoom: UUID?, audioRelativePath: String? = nil) -> CaptureResult {
        let spanning = startedInRoom != endedInRoom
        pushUndo()
        let observation = Observation(
            id: UUID(),
            roomID: spanning ? nil : (endedInRoom ?? startedInRoom),
            text: text,
            source: .spoken,
            status: spanning ? .uncertain : .confirmed,
            spanningTransition: spanning,
            startedAt: now(),
            endedAt: now(),
            audioRelativePath: audioRelativePath,
            photoRelativePath: nil
        )
        document.observations.append(observation)
        log("spokenNote", entityIDs: [startedInRoom, endedInRoom].compactMap { $0 }, detail: spanning ? "uncertain" : "confirmed")
        return .ok
    }

    func beginSpokenNote() {
        document.inProgress.recordingStartRoomID = document.inProgress.activeRoomID ?? document.inProgress.lastFinishedRoomID
    }

    @discardableResult
    func pauseCapture() -> CaptureResult {
        pushUndo()
        if let roomID = document.inProgress.lastFinishedRoomID ?? document.inProgress.activeRoomID,
           document.inProgress.promptQueue.isEmpty
        {
            document.inProgress.promptQueue = InterviewPrompt.standardRoomPrompts(roomID: roomID)
        }
        document.inProgress.phase = .paused
        log("paused", detail: "")
        return .ok
    }

    @discardableResult
    func resumeCapture() -> CaptureResult {
        if document.floor == nil {
            document.inProgress.phase = .awaitingFloor
            document.inProgress.walkRecording = false
        } else {
            document.inProgress.phase = .walking
            document.inProgress.walkRecording = true
            document.inProgress.walkSamples = []
            document.inProgress.walkPoses = []
            document.inProgress.walkRoomStartedAt = now()
            document.inProgress.activeRoomID = nil
            document.inProgress.overseerStatus = "guide-listening"
            document.inProgress.lastError = nil
        }
        return .ok
    }

    @discardableResult
    func undo() -> CaptureResult {
        guard let previous = undoStack.popLast() else { return fail(.nothingToUndo) }
        document = previous
        undoDepth = undoStack.count
        return .ok
    }

    func renameRoom(id: UUID, name: String) -> CaptureResult {
        guard var room = document.room(id: id) else { return fail(.unknownRoom) }
        pushUndo()
        room.name = name
        room.revision += 1
        document.replaceRoom(room)
        return .ok
    }

    func setRoomType(id: UUID, type: RoomType) -> CaptureResult {
        guard var room = document.room(id: id) else { return fail(.unknownRoom) }
        pushUndo()
        room.type = type
        room.revision += 1
        document.replaceRoom(room)
        return .ok
    }

    /// Record the homeowner's tape measurement for a room. Validation data only.
    func setTapeSize(id: UUID, width: Double?, depth: Double?) -> CaptureResult {
        guard var room = document.room(id: id) else { return fail(.unknownRoom) }
        pushUndo()
        if let width, let depth, width > 0, depth > 0 {
            room.tapeSize = Vec2(x: width, y: depth)
        } else {
            room.tapeSize = nil
        }
        document.replaceRoom(room)
        log("tapeSize", entityIDs: [id], detail: room.tapeSize.map { String(format: "%.2f x %.2f", $0.x, $0.y) } ?? "cleared")
        return .ok
    }

    /// Import only reviewed plan fields. Capture media, geographic anchors and
    /// the original recording remain intact; one accepted revision is one Undo.
    func applyReviewedPlan(_ reviewed: CaptureDocument, revision: Int, kind: String) throws {
        guard reviewed.sessionID == document.sessionID, reviewed.floor == document.floor,
              reviewed.geo == document.geo, reviewed.site == document.site,
              reviewed.rooms.allSatisfy({ Geometry.validateClosedPolygon($0.editedPolygon) == nil }) else {
            throw NSError(domain: "PlanReview", code: 1, userInfo: [NSLocalizedDescriptionKey: "The revised plan does not match this capture or has invalid room outlines."])
        }
        pushUndo()
        document.rooms = reviewed.rooms
        document.doorways = reviewed.doorways
        document.capturedItems = reviewed.capturedItems
        document.transcript = reviewed.transcript
        document.observations = reviewed.observations
        document.planReview = PlanReviewReference(revision: revision, kind: kind)
        log("planReviewed", detail: "Revision \(revision + 1), \(kind)")
    }

    func adjustCorner(roomID: UUID, index: Int, to point: Vec2) -> CaptureResult {
        guard var room = document.room(id: roomID) else { return fail(.unknownRoom) }
        guard room.editedPolygon.indices.contains(index) else { return fail(.invalidPhase) }
        var next = room.editedPolygon
        next[index] = point
        if let issue = Geometry.validateClosedPolygon(next) {
            return fail(.from(issue))
        }
        pushUndo()
        room.editedPolygon = next
        room.revision += 1
        document.replaceRoom(room)
        return .ok
    }

    @discardableResult
    func beginWalk(_ hit: PlacementHit, sampleInitialPose: Bool = true) -> CaptureResult {
        if document.floor == nil {
            // The first hit defines the floor. A tabletop or a hit at the
            // AR origin (chest height) would put every later sample on the
            // wrong plane, so check the camera is a walking height above it.
            let cameraHeight = (hit.rayOrigin - hit.world).dot(Vec3.up)
            if cameraHeight < Geometry.minFloorCameraHeight || cameraHeight > Geometry.maxFloorCameraHeight {
                return fail(.notTheFloor(cameraHeight: cameraHeight))
            }
            let confirmed = confirmFloor(hit)
            guard confirmed.isOK else { return confirmed }
        }
        pushUndo()
        document.inProgress.phase = .walking
        document.inProgress.walkRecording = true
        document.inProgress.walkSamples = []
        document.inProgress.walkPoses = []
        document.inProgress.walkRoomStartedAt = now()
        document.inProgress.walkRoomName = nil
        document.inProgress.walkRoomType = nil
        document.inProgress.activeRoomID = nil
        document.inProgress.overseerStatus = "guide-listening"
        document.inProgress.lastError = nil
        log("walkStarted", detail: "video+audio requested")
        if sampleInitialPose { _ = sampleWalk(hit) }
        return .ok
    }

    /// Convenience for a hit whose ray origin is the camera (tests, Simulator).
    @discardableResult
    func sampleWalk(_ hit: PlacementHit) -> CaptureResult {
        sampleWalk(
            camera: CameraPose(position: hit.rayOrigin, forward: hit.rayDirection, trackingNormal: true),
            hit: hit
        )
    }

    /// One walk sample. The room is measured from where the phone *is*; the
    /// crosshair hit is kept as evidence but never widens the room — the
    /// floor plane is infinite, so a hit is often on the far side of a wall.
    @discardableResult
    func sampleWalk(camera: CameraPose, hit: PlacementHit?) -> CaptureResult {
        guard phase == .walking else { return .failed(.invalidPhase) }
        guard let floor = document.floor else { return .failed(.noFloor) }
        // Skip quietly: a live walk should not flash errors.
        guard camera.trackingNormal else { return .ok }
        let height = (camera.position - floor.basis.origin).dot(floor.basis.yAxis)
        // Phone on a table, or a tracking jump: not a walking sample.
        if height < Geometry.minFloorCameraHeight || height > Geometry.maxFloorCameraHeight { return .ok }
        let cameraPlan = floor.basis.toPlan(camera.position)

        var hitPlan: Vec2?
        if let hit {
            let steepness = abs(hit.rayDirection.dot(floor.basis.yAxis))
            if steepness >= settings.minRayFloorDot,
               let world = intersectFloor(hit, floor: floor.basis)
            {
                let distance = (world - hit.rayOrigin).length
                if distance <= settings.maxHitDistance && distance >= Geometry.minHitDistance {
                    hitPlan = floor.basis.toPlan(world)
                }
            }
        }
        // Heading the phone faces, in the plan. Meaningless when pointing straight down.
        let fx = camera.forward.dot(floor.basis.xAxis)
        let fz = camera.forward.dot(floor.basis.zAxis)
        let yaw: Double? = hypot(fx, fz) >= 0.3 ? atan2(fz, fx) : nil

        document.inProgress.walkPoses.append(
            WalkPose(t: now(), camera: cameraPlan, hit: hitPlan, cameraHeight: height, yaw: yaw)
        )
        if let last = document.inProgress.walkSamples.last, last.distance(to: cameraPlan) < 0.12 {
            return .ok
        }
        document.inProgress.walkSamples.append(cameraPlan)
        return .ok
    }

    /// Rotate every plan-space quantity by `-angle` (world data is untouched)
    /// and rotate the floor basis to match, so walls at `angle` become axis-aligned.
    private func rotatePlan(by angle: Double) {
        guard var floor = document.floor else { return }
        floor.basis = floor.basis.rotated(byYaw: angle)
        floor.gridAngle = (floor.gridAngle ?? 0) + angle
        document.floor = floor
        let r: (Vec2) -> Vec2 = { $0.rotated(by: -angle) }
        func rotatePose(_ p: WalkPose) -> WalkPose {
            var q = p
            q.camera = r(p.camera)
            q.hit = p.hit.map(r)
            q.yaw = p.yaw.map { $0 - angle }
            return q
        }
        document.inProgress.walkSamples = document.inProgress.walkSamples.map(r)
        document.inProgress.walkPoses = document.inProgress.walkPoses.map(rotatePose)
        document.inProgress.points = document.inProgress.points.map { p in
            var q = p
            q.rawPlan = r(p.rawPlan)
            q.snappedPlan = r(p.snappedPlan)
            return q
        }
        document.rooms = document.rooms.map { room in
            var m = room
            m.editedPolygon = room.editedPolygon.map(r)
            m.capturedPoints = room.capturedPoints.map { p in
                var q = p
                q.rawPlan = r(p.rawPlan)
                q.snappedPlan = r(p.snappedPlan)
                return q
            }
            m.walkTrail = room.walkTrail.map(r)
            m.walkPath = room.walkPath.map(r)
            m.walkPoses = room.walkPoses.map(rotatePose)
            return m
        }
        document.doorways = document.doorways.map { d in
            var m = d
            m.endpointA = r(d.endpointA)
            m.endpointB = r(d.endpointB)
            return m
        }
        if var draft = document.inProgress.pendingDoorway {
            draft.endpointA = r(draft.endpointA)
            draft.endpointB = r(draft.endpointB)
            document.inProgress.pendingDoorway = draft
        }
        document.alignmentChecks = document.alignmentChecks.map { c in
            var m = c
            m.cameraPlan = r(c.cameraPlan)
            m.doorwayMidpoint = r(c.doorwayMidpoint)
            return m
        }
        if var geo = document.geo {
            geo.cameraPlan = r(geo.cameraPlan)
            document.geo = geo
        }
        document.geoSamples = document.geoSamples.map { sample in
            var rotated = sample
            rotated.cameraPlan = r(sample.cameraPlan)
            return rotated
        }
        if document.site?.footprintPlan != nil {
            // Re-place from scratch: rotation snapping depends on the grid angle.
            placeSiteIfPossible()
        }
    }

    /// Try to find the wall grid from everything walked so far. Rooms already
    /// boxed before alignment are only rotated, not re-boxed; the plan is
    /// re-boxed on device by the user dragging corners if needed.
    private func alignGridIfPossible() -> Bool {
        guard document.floor != nil, document.floor?.gridAngle == nil else { return false }
        if settings.gridAngleOverride != nil { return false }   // manual: never auto-rotate
        let poses = document.rooms.flatMap(\.walkPoses) + document.inProgress.walkPoses
        let path = document.rooms.flatMap(\.walkTrail) + document.inProgress.walkSamples
        let yaws = poses.compactMap(\.yaw)
        guard let angle = Geometry.dominantAngle(yaws: yaws, minSamples: settings.yawMinSamples, minInlierFraction: settings.yawMinInlierFraction)
            ?? Geometry.dominantAngle(of: path)
        else { return false }
        rotatePlan(by: angle)
        log("gridAligned", detail: String(format: "%.1f° from %d headings", angle * 180 / .pi, yaws.count))
        return true
    }

    // MARK: - Live tuning

    /// Apply new tunables. The in-progress box follows immediately (it is
    /// computed from stored poses); closed rooms are re-derived on request.
    func updateSettings(_ next: CaptureSettings, reboxRooms: Bool = false) {
        pushUndo()
        let previousOverride = settings.gridAngleOverride
        document.settings = next
        if let override = next.gridAngleOverride, override != previousOverride, document.floor != nil {
            let current = document.floor?.gridAngle ?? 0
            rotatePlan(by: override - current)
            document.floor?.gridAngle = override
            log("gridOverride", detail: String(format: "%.1f°", override * 180 / .pi))
        }
        if reboxRooms { self.reboxRooms() }
        log("settings", detail: String(format: "pad %.2f hits %d", next.pad, next.measureFromHits ? 1 : 0))
    }

    /// Force the automatic alignment now, even mid-room. No-op without evidence.
    @discardableResult
    func alignGridNow() -> Bool {
        pushUndo()
        if document.floor?.gridAngle != nil, settings.gridAngleOverride == nil {
            // Already aligned automatically: allow a re-estimate from all evidence.
            document.floor?.gridAngle = nil
        }
        return alignGridIfPossible()
    }

    /// Re-derive every walk room from its stored poses with the current
    /// settings: box, door pin, shared-wall snap, doorway position. Raw
    /// evidence is untouched; edits made by dragging corners are lost.
    func reboxRooms() {
        var previousID: UUID?
        for i in document.rooms.indices {
            var room = document.rooms[i]
            guard !room.walkPoses.isEmpty else { previousID = room.id; continue }
            let pts = boxPoints(for: room.walkPoses)
            guard !pts.isEmpty else { previousID = room.id; continue }
            var raw = Geometry.roomBox(from: pts, pad: settings.pad, minSide: settings.minSide)
            if let tap = room.doorTapPoint {
                raw = Geometry.pinBoxEdge(raw, to: tap, maxPull: settings.pad + 0.15, minSide: settings.minSide)
            }
            var edited = raw
            var shift: Double?
            if let prevID = previousID,
               document.doorways.contains(where: { $0.connectedRoomIDs.contains(room.id) && $0.connectedRoomIDs.contains(prevID) }),
               let prev = document.room(id: prevID),
               let snapped = Geometry.snapBoxToNeighbor(raw, neighbor: prev.displayPolygon, maxShift: settings.sharedWallMaxShift, minSide: settings.minSide)
            {
                edited = snapped.box
                shift = snapped.shift
            }
            room.capturedPoints = raw.map { p in
                CapturedPoint(id: UUID(), rawWorld: document.floor?.basis.toWorld(p) ?? Vec3(x: p.x, y: 0, z: p.y), rawPlan: p, snappedPlan: p, isApproximate: true, wasSnapped: false)
            }
            room.editedPolygon = edited
            room.wallSnapShift = shift
            room.revision += 1
            document.rooms[i] = room
            // Move this room's doorway back onto its (new) wall at the tap point.
            if let tap = room.doorTapPoint,
               let di = document.doorways.firstIndex(where: { $0.wallRoomID == room.id }),
               let edge = Geometry.closestEdge(polygon: edited, point: tap),
               let pair = Geometry.doorwayFromCenter(polygon: edited, edgeIndex: edge.index, centerT: edge.t, width: document.doorways[di].width)
            {
                document.doorways[di].wallEdgeIndex = edge.index
                document.doorways[di].endpointA = pair.0
                document.doorways[di].endpointB = pair.1
            }
            previousID = room.id
        }
        document.mismatches = []
        for di in document.doorways.indices { evaluateMismatch(doorwayIndex: di) }
        log("reboxed", detail: "\(document.rooms.count) rooms")
    }

    func setWalkRoomName(_ name: String, type: RoomType = .other) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        document.inProgress.walkRoomName = trimmed.isEmpty ? nil : trimmed
        document.inProgress.walkRoomType = type
        log("walkRoomNamed", detail: trimmed)
    }

    @discardableResult
    func finishWalkRoom(name: String, type: RoomType, doorPoint: Vec2? = nil) -> CaptureResult {
        guard phase == .walking else { return fail(.invalidPhase) }
        guard var floor = document.floor else { return fail(.noFloor) }
        guard !document.inProgress.walkSamples.isEmpty else { return fail(.tooFewPoints) }
        pushUndo()

        // Align the plan grid to the walls as soon as there is enough heading
        // evidence. The AR world axes are whatever heading the phone had when
        // the session started; boxing a room in that frame inflates a rotated
        // rectangle. Everything in plan space is rotated together.
        _ = alignGridIfPossible()
        floor = document.floor ?? floor

        let samples = document.inProgress.walkSamples
        let boxSource = boxPoints(for: document.inProgress.walkPoses)
        var rawBox = Geometry.roomBox(from: boxSource.isEmpty ? samples : boxSource, pad: settings.pad, minSide: settings.minSide)
        if let doorPoint {
            // The tap happened in the doorway: that wall is exactly there.
            rawBox = Geometry.pinBoxEdge(rawBox, to: doorPoint, maxPull: settings.pad + 0.15, minSide: settings.minSide)
        }
        var editedBox = rawBox
        var snapShift: Double?
        if let draft = document.inProgress.pendingDoorway,
           let neighbor = document.room(id: draft.roomID),
           let snapped = Geometry.snapBoxToNeighbor(rawBox, neighbor: neighbor.displayPolygon, maxShift: settings.sharedWallMaxShift, minSide: settings.minSide)
        {
            editedBox = snapped.box
            snapShift = snapped.shift
        }
        if let issue = Geometry.validateClosedPolygon(editedBox) {
            return fail(.from(issue))
        }

        let points: [CapturedPoint] = rawBox.map { p in
            CapturedPoint(
                id: UUID(),
                rawWorld: floor.basis.toWorld(p),
                rawPlan: p,
                snappedPlan: p,
                isApproximate: true,
                wasSnapped: false
            )
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = trimmed.isEmpty
            ? (document.inProgress.walkRoomName ?? currentRoomLabel)
            : trimmed
        let resolvedType = document.inProgress.walkRoomType ?? type
        let room = Room(
            id: UUID(),
            name: resolvedName,
            type: resolvedType,
            capturedPoints: points,
            editedPolygon: editedBox,
            revision: 1,
            isApproximate: true,
            createdAt: now(),
            walkTrail: samples,
            walkPath: document.inProgress.walkPoses.map(\.camera),
            walkPoses: document.inProgress.walkPoses,
            walkStartedAt: document.inProgress.walkRoomStartedAt,
            walkEndedAt: now(),
            tapeSize: nil,
            wallSnapShift: snapShift,
            doorTapPoint: doorPoint
        )
        document.rooms.append(room)
        // Things heard while this room was being walked belong to it.
        if let started = document.inProgress.walkRoomStartedAt {
            for i in document.capturedItems.indices where document.capturedItems[i].roomID == nil && document.capturedItems[i].timestamp >= started {
                document.capturedItems[i].roomID = room.id
            }
            // A sentence that ends while this room is being walked belongs to it.
            for i in document.transcript.indices where document.transcript[i].roomID == nil && document.transcript[i].endedAt >= started {
                document.transcript[i].roomID = room.id
            }
        }
        if let pending = document.inProgress.pendingDoorway {
            attach(roomID: room.id, toPending: pending)
        }
        if let shift = snapShift {
            log("sharedWallSnap", entityIDs: [room.id], detail: String(format: "%.2f m", shift))
        }
        document.inProgress.points = []
        document.inProgress.walkSamples = []
        document.inProgress.walkPoses = []
        document.inProgress.walkRoomName = nil
        document.inProgress.walkRoomType = nil
        document.inProgress.walkRoomStartedAt = now()
        document.inProgress.activeRoomID = nil
        document.inProgress.lastFinishedRoomID = room.id
        document.inProgress.promptQueue = []
        document.inProgress.phase = .walking
        document.inProgress.lastError = nil
        log("roomFinished", entityIDs: [room.id], detail: room.name)
        placeSiteIfPossible()
        return .ok
    }

    @discardableResult
    func throughDoor() -> CaptureResult {
        guard phase == .walking else { return fail(.invalidPhase) }
        guard !document.inProgress.walkSamples.isEmpty else { return fail(.tooFewPoints) }
        // The person is standing in the doorway; the crosshair is a couple of
        // metres ahead of them. Place the door where the body is.
        var doorPoint = document.inProgress.walkPoses.last?.camera ?? document.inProgress.walkSamples.last
        let name = document.inProgress.walkRoomName ?? currentRoomLabel
        let type = document.inProgress.walkRoomType ?? .other
        // Alignment may rotate the plan while this room closes; align first so
        // the door point and the box live in the same frame.
        _ = alignGridIfPossible()
        doorPoint = document.inProgress.walkPoses.last?.camera ?? document.inProgress.walkSamples.last ?? doorPoint
        let finished = finishWalkRoom(name: name, type: type, doorPoint: doorPoint)
        guard finished.isOK, let room = document.rooms.last else { return finished }
        if let point = doorPoint {
            if let edge = Geometry.closestEdge(polygon: room.displayPolygon, point: point) {
                _ = placeDoorwayCenter(roomID: room.id, edgeIndex: edge.index, center: edge.projected, width: 0.9)
            }
        }
        document.inProgress.phase = .walking
        document.inProgress.walkSamples = []
        document.inProgress.walkPoses = []
        log("throughDoor", entityIDs: [room.id], detail: "walk")
        return .ok
    }

    func toggleChecklistItem(_ id: UUID) {
        guard let idx = document.inProgress.checklist.firstIndex(where: { $0.id == id }) else { return }
        document.inProgress.checklist[idx].done.toggle()
        document.inProgress.checklist[idx].doneAt = document.inProgress.checklist[idx].done ? now() : nil
        document.inProgress.checklist[idx].skippedAt = nil
        if !document.inProgress.checklist[idx].done { document.inProgress.checklist[idx].evidenceItemID = nil }
        log("checklist", detail: document.inProgress.checklist[idx].title)
    }

    func setWalkMedia(video: String?, audio: String?) {
        if let video { document.inProgress.videoRelativePath = video }
        if let audio { document.inProgress.audioRelativePath = audio }
    }

    var media: MediaRecord? { document.media }
    var alignmentChecks: [AlignmentCheck] { document.alignmentChecks }
    var geo: GeoRecord? { document.geo }
    var site: SiteRecord? { document.site }
    var footprintPlan: [Vec2]? { document.site?.footprintPlan }

    func appendGeoSample(_ record: GeoRecord) {
        guard walkRecording else { return }
        document.geoSamples.append(record)
    }

    func setGeo(_ record: GeoRecord) {
        document.geo = record
        log("geo", detail: String(format: "±%.0f m, heading %@", record.horizontalAccuracy, record.headingAligned ? "aligned" : "not aligned"))
        placeSiteIfPossible()
    }

    func setSite(_ site: SiteRecord) {
        pushUndo()
        document.site = site
        log("site", detail: String(format: "%.0f m² footprint", site.areaSquareMeters))
        placeSiteIfPossible()
    }

    /// Anchor capture to the recorded GPS fix. The whole-walk box is only a
    /// provisional envelope, so it must not drag the property away from the entry.
    /// Room-based containment belongs to post-processing after segmentation.
    func placeSiteIfPossible() {
        guard var site = document.site, let geo = document.geo, geo.headingAligned else { return }
        let placed = SitePlacement.place(site: site, geo: geo, gridAngle: document.floor?.gridAngle, rooms: [])
        site.footprintPlan = placed.plan
        site.placementNote = placed.note
        document.site = site
    }

    func setMedia(_ record: MediaRecord) {
        var merged = document.media ?? MediaRecord()
        if record.videoPath != nil {
            merged.videoPath = record.videoPath
            merged.videoStartedAt = record.videoStartedAt
            merged.videoStartFrameTimestamp = record.videoStartFrameTimestamp
            merged.videoEndedAt = record.videoEndedAt
            merged.videoFrames = record.videoFrames
            merged.videoDroppedFrames = record.videoDroppedFrames
            merged.videoWidth = record.videoWidth
            merged.videoHeight = record.videoHeight
            merged.videoTargetFPS = record.videoTargetFPS
            document.inProgress.videoRelativePath = record.videoPath
        }
        if record.audioPath != nil {
            merged.audioPath = record.audioPath
            merged.audioStartedAt = record.audioStartedAt
            merged.audioEndedAt = record.audioEndedAt
            document.inProgress.audioRelativePath = record.audioPath
        }
        document.media = merged
        log("media", detail: record.videoPath ?? record.audioPath ?? "")
    }

    /// The user is standing in a doorway they marked earlier. Record how far
    /// the tracked position is from it. Nothing moves; this is drift evidence.
    @discardableResult
    func checkAlignment(cameraPlan: Vec2) -> CaptureResult {
        guard document.floor != nil else { return fail(.noFloor) }
        pushUndo()
        // The door just walked through is still a draft until the next room
        // closes; it is the most likely one to be checked, so commit it.
        if let draft = document.inProgress.pendingDoorway {
            _ = commitDraftIfNeeded(draft)
        }
        var best: (Doorway, Vec2, Double)?
        for door in document.doorways {
            let mid = Vec2(x: (door.endpointA.x + door.endpointB.x) / 2, y: (door.endpointA.y + door.endpointB.y) / 2)
            let d = mid.distance(to: cameraPlan)
            if best == nil || d < best!.2 { best = (door, mid, d) }
        }
        guard let (door, mid, distance) = best else { return fail(.invalidDoorway) }
        let check = AlignmentCheck(
            id: UUID(),
            timestamp: now(),
            doorwayID: door.id,
            cameraPlan: cameraPlan,
            doorwayMidpoint: mid,
            distanceMeters: distance,
            trackingState: tracking.label
        )
        document.alignmentChecks.append(check)
        document.inProgress.lastError = nil
        log("alignmentCheck", entityIDs: [door.id], detail: String(format: "%.2f m", distance))
        return .ok
    }

    func setAccountManagerJoined(_ joined: Bool) {
        document.inProgress.accountManagerJoined = joined
        log("accountManager", detail: joined ? "joined-placeholder" : "not-joined")
    }

    func stopWalkRecording() {
        document.inProgress.walkRecording = false
        if !document.inProgress.walkSamples.isEmpty {
            let name = document.inProgress.walkRoomName ?? currentRoomLabel
            let type = document.inProgress.walkRoomType ?? .other
            _ = finishWalkRoom(name: name, type: type)
        }
        document.inProgress.phase = .reviewing
    }

    func goToReview() {
        document.inProgress.phase = .reviewing
    }

    func prepareNote(on roomID: UUID) {
        document.inProgress.activeRoomID = roomID
        if document.inProgress.promptQueue.isEmpty {
            document.inProgress.promptQueue = [
                InterviewPrompt(
                    id: UUID(),
                    roomID: roomID,
                    text: "Anything someone should know about using this room?",
                    kind: "usage"
                )
            ]
        }
        document.inProgress.phase = .interviewing
    }

    func setLastError(_ message: String) {
        document.inProgress.lastError = message
    }

    func exportedJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .secondsSince1970
        return try encoder.encode(document)
    }

    static func fromJSON(_ data: Data) throws -> CaptureSession {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let doc = try decoder.decode(CaptureDocument.self, from: data)
        return CaptureSession(document: doc, tracking: .normal)
    }

    func svgString() -> String {
        SVGExport.render(document: document)
    }

    func extrudedFootprints(wallHeight: Double = Extrusion.defaultWallHeight) -> [ExtrudedRoom] {
        Extrusion.extrude(rooms: document.rooms, wallHeight: wallHeight)
    }

    // MARK: - Internals

    private func now() -> TimeInterval { clock() }

    /// A replay seek rebuilds the same session from its empty seed, then feeds
    /// the normal capture methods again. No precomputed rooms are restored.
    func resetReplay(to seed: CaptureDocument) {
        precondition(seed.deviceCapabilities.captureMode == "replay")
        document = seed
        tracking = .normal
        undoStack = []
        undoDepth = 0
    }

    private func pushUndo() {
        undoStack.append(document)
        if undoStack.count > maxUndo {
            undoStack.removeFirst(undoStack.count - maxUndo)
        }
        undoDepth = undoStack.count
    }

    private func fail(_ error: PlacementError) -> CaptureResult {
        document.inProgress.lastError = error.description
        return .failed(error)
    }

    private func log(_ type: String, entityIDs: [UUID] = [], detail: String) {
        document.events.append(
            SessionEvent(
                id: UUID(),
                timestamp: now(),
                type: type,
                entityIDs: entityIDs,
                status: "confirmed",
                detail: detail
            )
        )
    }

    private func validateRay(_ hit: PlacementHit, floor: FloorBasis?) -> PlacementError? {
        let normal = floor?.yAxis ?? Vec3.up
        let denom = hit.rayDirection.dot(normal)
        if abs(denom) < Geometry.minRayFloorDot { return .rayNearParallel }
        if hit.distance < Geometry.minHitDistance || hit.distance > Geometry.maxHitDistance {
            return .unreasonableDistance
        }
        return nil
    }

    private func intersectFloor(_ hit: PlacementHit, floor: FloorBasis) -> Vec3? {
        let denom = hit.rayDirection.dot(floor.yAxis)
        if abs(denom) < Geometry.minRayFloorDot { return nil }
        let t = (floor.origin - hit.rayOrigin).dot(floor.yAxis) / denom
        if t < Geometry.minHitDistance || t > Geometry.maxHitDistance { return nil }
        return hit.rayOrigin + hit.rayDirection * t
    }

    private func advancePromptLocked() {
        if !document.inProgress.promptQueue.isEmpty {
            document.inProgress.promptQueue.removeFirst()
        }
        if document.inProgress.promptQueue.isEmpty {
            document.inProgress.phase = .placingDoorway
        }
    }

    @discardableResult
    private func commitDraftIfNeeded(_ draft: DoorwayDraft) -> UUID {
        if let existing = document.doorways.first(where: {
            $0.wallRoomID == draft.roomID
                && $0.wallEdgeIndex == draft.edgeIndex
                && $0.endpointA == draft.endpointA
                && $0.endpointB == draft.endpointB
        }) {
            return existing.id
        }
        let door = Doorway(
            id: UUID(),
            wallRoomID: draft.roomID,
            wallEdgeIndex: draft.edgeIndex,
            endpointA: draft.endpointA,
            endpointB: draft.endpointB,
            width: draft.width,
            connectedRoomIDs: [draft.roomID],
            evidence: nil
        )
        document.doorways.append(door)
        return door.id
    }

    private func attach(roomID: UUID, toPending draft: DoorwayDraft) {
        let doorID = commitDraftIfNeeded(draft)
        if let idx = document.doorways.firstIndex(where: { $0.id == doorID }) {
            if !document.doorways[idx].connectedRoomIDs.contains(roomID) {
                document.doorways[idx].connectedRoomIDs.append(roomID)
            }
            evaluateMismatch(doorwayIndex: idx)
        }
        document.inProgress.pendingDoorway = nil
    }

    private func unmatchedDoorwayID() -> UUID? {
        document.doorways.first(where: { $0.connectedRoomIDs.count == 1 })?.id
    }

    private func evaluateMismatch(doorwayIndex: Int) {
        let door = document.doorways[doorwayIndex]
        guard door.connectedRoomIDs.count >= 2,
              let idA = door.connectedRoomIDs.first,
              let idB = door.connectedRoomIDs.dropFirst().first,
              let roomA = document.room(id: idA),
              let roomB = document.room(id: idB)
        else { return }

        let mid = Vec2(
            x: (door.endpointA.x + door.endpointB.x) / 2,
            y: (door.endpointA.y + door.endpointB.y) / 2
        )
        guard let edgeA = Geometry.closestEdge(polygon: roomA.displayPolygon, point: mid),
              let edgeB = Geometry.closestEdge(polygon: roomB.displayPolygon, point: mid),
              let dirA = Geometry.edgeDirection(polygon: roomA.displayPolygon, edgeIndex: edgeA.index),
              let dirB = Geometry.edgeDirection(polygon: roomB.displayPolygon, edgeIndex: edgeB.index)
        else { return }

        let distance = edgeA.projected.distance(to: edgeB.projected)
        var angle = Geometry.angleDegrees(dirA, dirB)
        angle = min(angle, 180 - angle)
        if distance > Geometry.mismatchDistance || angle > Geometry.mismatchAngleDegrees {
            let mismatch = OutlineMismatch(
                id: UUID(),
                doorwayID: door.id,
                roomA: idA,
                roomB: idB,
                distanceMeters: distance,
                angleDegrees: angle,
                summary: String(
                    format: "Adjacent outlines disagree by %.0f cm / %.0f°. No corridor was invented.",
                    distance * 100,
                    angle
                )
            )
            document.mismatches.removeAll { $0.doorwayID == door.id }
            document.mismatches.append(mismatch)
        }
    }
}
