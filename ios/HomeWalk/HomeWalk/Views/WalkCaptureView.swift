import Combine
import SwiftUI

struct WalkCaptureView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var session: CaptureSession
    var replay: CaptureReplay? = nil
    @StateObject private var hits = HitBridge()
    @StateObject private var speech = SpeechCapture()
    @State private var video = WalkVideoRecorder()
    @State private var celebrating: CapturedItem?
    @State private var pulsingPrompt: String?
    @State private var promptHint: String?
    @State private var alignmentToast: String?
    @StateObject private var live = LiveLink()
    @StateObject private var geo = GeoProvider()
    @AppStorage("homewalk.debug") private var debugEnabled = false
    @AppStorage("homewalk.liveHost") private var liveHost = ""
    @AppStorage("homewalk.address") private var siteAddress = ""
    @State private var showTune = false
    @State private var showDebugMap = false
    @State private var showChecklist = false
    @State private var showScript = false
    @State private var didStartMedia = false
    @State private var finishing = false
    @State private var checkpointTicks = 0
    @State private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @State private var now = Date()
    // Stored, not built in `body`: a publisher created per render is replaced
    // before it fires once the view re-renders faster than its interval.
    private let sampleClock = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()
    private let wallClock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var onDevice: Bool { SpatialCapabilities.worldTrackingSupported }
    private var floorFound: Bool { session.floor != nil || hits.candidatePlane != nil || !onDevice }
    private var canStart: Bool { floorFound && (session.canPlace || !onDevice) }

    var body: some View {
        ZStack {
            stage
            crosshair
            VStack(spacing: 0) {
                topBar
                instruction
                if debugEnabled, !showDebugMap {
                    HStack {
                        Spacer()
                        DebugHUDView(
                            session: session,
                            live: live,
                            videoStats: video.isRecording ? video.stats : nil,
                            onTune: { showTune = true },
                            onMap: { showDebugMap = true }
                        )
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
                }
                if let err = session.lastError {
                    Text(err)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(HWTheme.paper)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HWTheme.stamp.opacity(0.92))
                        .accessibilityIdentifier("walk-error")
                }
                if let toast = alignmentToast {
                    Text(toast)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(HWTheme.navy)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(HWTheme.tape.opacity(0.95))
                        .accessibilityIdentifier("alignment-toast")
                }
                if debugEnabled, showDebugMap {
                    DebugMapView(session: session) { showDebugMap = false }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxHeight: .infinity)
                } else {
                    Spacer()
                }
                HStack(alignment: .bottom) {
                    miniMap
                    Spacer()
                    specialistBubble
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                if !onDevice, replay == nil {
                    simulatorHint
                }
                if session.walkRecording {
                    heardStrip
                    promptRow
                } else {
                    checklistPeek
                }
                if let replay { ReplayTransportView(replay: replay) }
                controls
            }
        }
        .ignoresSafeArea(edges: .bottom)
        .onAppear {
            if replay != nil { return }
            configureSpeech()
            if session.walkRecording { ensureMedia() }
            geo.request()
            configureLiveLink()
        }
        .onDisappear {
            replay?.pause()
            UIApplication.shared.isIdleTimerDisabled = false
            if didStartMedia { stopMedia {} }
            live.disconnect()
            geo.stop()
        }
        .onReceive(sampleClock) { _ in
            sampleIfWalking()
        }
        .onReceive(wallClock) { date in
            if let replay { now = Date(timeIntervalSince1970: replay.fixture.startUnix + replay.position); return }
            now = date
            recordGeoIfReady()
            if session.walkRecording {
                if onDevice, let sample = geo.record(headingAligned: hits.headingAligned, cameraPlan: session.walkPoses.last?.camera ?? .zero) {
                    session.appendGeoSample(sample)
                }
                checkpointTicks += 1
                if checkpointTicks % 5 == 0 { checkpointMedia() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard session.walkRecording else { return }
            session.recordCaptureEvent("appState", detail: String(describing: phase))
            checkpointMedia()
            // iOS suspends the camera in the background. Finalize the capture
            // while background time is available instead of claiming to record.
            if phase == .background { stopWalk() }
        }
        .onChange(of: hits.aim) { _, _ in sampleIfWalking() }
        .onChange(of: geo.authorization) { _, _ in
            // Location granted on this screen: restart tracking compass-aligned
            // as long as nothing has been measured yet.
            if geo.authorized, onDevice, !hits.headingAligned, session.floor == nil {
                hits.source?.restartTracking()
            }
        }
        .sheet(isPresented: $showChecklist) { checklistSheet }
        .sheet(isPresented: $showTune) {
            TuneSheet(session: session, live: live, liveHost: $liveHost, siteAddress: $siteAddress) { app.persist() }
        }
        .sheet(isPresented: $showScript) { scriptSheet }

    }

    // MARK: - Stage

    private var stage: some View {
        Group {
            if let replay {
                ReplayVideoView(player: replay.player).ignoresSafeArea()
            } else if onDevice {
                ARKitCaptureView(session: session, hits: hits)
                    .ignoresSafeArea()
            } else {
                SimulatorFloorView(hits: hits, session: session)
                    .ignoresSafeArea()
            }
        }
    }

    /// Centre reticle. Before the walk it shows whether a floor is under it.
    private var crosshair: some View {
        Group {
            if onDevice {
                ZStack {
                    Circle()
                        .stroke(floorFound ? HWTheme.tape : HWTheme.paper.opacity(0.6), lineWidth: 2)
                        .frame(width: 26, height: 26)
                    Circle()
                        .fill(floorFound ? HWTheme.tape : HWTheme.paper.opacity(0.6))
                        .frame(width: 4, height: 4)
                }
                .allowsHitTesting(false)
            }
        }
    }

    // MARK: - Top

    private var elapsedLabel: String? {
        if replay != nil { return nil }
        guard session.walkRecording,
              let start = session.events.first(where: { $0.type == "walkStarted" })?.timestamp
        else { return nil }
        let secs = max(0, Int(now.timeIntervalSince1970 - start))
        return String(format: "%d:%02d", secs / 60, secs % 60)
    }

    private var statusLine: (text: String, color: Color) {
        if session.walkRecording {
            if onDevice, !session.canPlace {
                return (session.tracking.label, HWTheme.rust)
            }
            return ((replay == nil ? "Recording" : "Replaying recorded walk") + (elapsedLabel.map { " · \($0)" } ?? ""), HWTheme.stamp)
        }
        if onDevice {
            if !session.canPlace { return (session.tracking.label, HWTheme.tape) }
            let compass = hits.headingAligned ? " · compass" : ""
            return floorFound ? ("Floor found\(compass)", HWTheme.moss) : ("Looking for the floor…\(compass)", HWTheme.tape)
        }
        return ("Simulator", HWTheme.paper.opacity(0.6))
    }

    private var topBar: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(statusLine.color)
                        .frame(width: 8, height: 8)
                    Text(statusLine.text)
                        .font(.system(.caption, design: .rounded).weight(.semibold))
                        .monospacedDigit()
                        .accessibilityIdentifier("tracking-indicator")
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(session.walkRecording ? "Walking your home" : "Ready to walk")
                        .font(.headline)
                        .accessibilityIdentifier("current-room-label")
                }

            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "waveform")
                        .font(.system(size: 10, weight: .bold))
                    Text("Guide on")
                        .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(HWTheme.navy)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(HWTheme.brass)
                .clipShape(Capsule())
                .accessibilityIdentifier("overseer-placeholder")
                HStack(spacing: 12) {
                    if debugEnabled, session.walkRecording, !session.doorways.isEmpty {
                        Button("Check door") { checkAlignment() }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HWTheme.brass)
                            .accessibilityIdentifier("check-alignment")
                    }
                    Button("Script") { showScript = true }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HWTheme.brass)
                        .accessibilityIdentifier("open-script")
                }
            }
        }
        .foregroundStyle(HWTheme.paper)
        .padding(.horizontal, 14)
        .padding(.top, 54)
        .padding(.bottom, 10)
        .background(HWTheme.navy.opacity(0.92))
    }

    private var instructionText: String {
        if !session.walkRecording {
            if replay != nil { return "Start walk to replay your recorded camera, audio, and movement." }
            return onDevice ? WalkCopy.floorPrompt : "Drag the grid to walk. Start when ready."
        }
        if session.walkSamples.count < 4 {
            return WalkCopy.walkPrompt
        }
        return "Keep walking close to the walls. Say which room you enter and what you show. We assemble the plan afterwards."
    }

    private var instruction: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(instructionText)
                .font(.system(.callout, design: .serif))
                .fixedSize(horizontal: false, vertical: true)
            if session.walkRecording, !SpeechCapture.speechAuthorized, onDevice {
                Text("Speech recognition is off. Keep talking; your audio is saved for processing after the walk.")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HWTheme.tape)
            }
        }
        .foregroundStyle(HWTheme.paper)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(HWTheme.overlay)
        .accessibilityIdentifier("walk-prompt")
    }

    // MARK: - Middle

    private var miniMap: some View {
        VStack(alignment: .leading, spacing: 4) {
            MiniMapView(session: session, captureOnly: true)
                .frame(width: 150, height: 150)
                .accessibilityIdentifier("mini-map")

        }
    }

    private var simulatorHint: some View {
        Text("Simulator: drag the grid to walk the walls.")
            .font(.caption)
            .foregroundStyle(HWTheme.paper.opacity(0.8))
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .accessibilityIdentifier("simulator-walk-hint")
    }

    private var specialistBubble: some View {
        Button {
            session.setAccountManagerJoined(!session.accountManagerJoined)
            app.persist()
        } label: {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(session.accountManagerJoined ? HWTheme.brass : HWTheme.ink.opacity(0.7))
                        .frame(width: 48, height: 48)
                        .overlay(Circle().stroke(HWTheme.paper.opacity(0.5), lineWidth: 1))
                    Image(systemName: session.accountManagerJoined ? "person.fill" : "person")
                        .font(.system(size: 20))
                        .foregroundStyle(session.accountManagerJoined ? HWTheme.navy : HWTheme.paper)
                }
                Text(session.accountManagerJoined ? "Specialist" : "Invite")
                    .font(.caption2)
                    .foregroundStyle(HWTheme.paper)
            }
        }
        .accessibilityIdentifier("account-manager-placeholder")
        .accessibilityLabel(
            session.accountManagerJoined
                ? "Specialist joined."
                : "Invite a specialist."
        )
    }

    /// What the phone is hearing, and the things it has captured, popping in.
    private var heardStrip: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !speech.partialText.isEmpty {
                Text("“\(speech.partialText)”")
                    .font(.footnote.italic())
                    .foregroundStyle(HWTheme.paper.opacity(0.85))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
                    .accessibilityIdentifier("heard-partial")
            }
            let items = session.capturedItems.suffix(8).reversed()
            if !items.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(items)) { item in
                            HStack(spacing: 4) {
                                Image(systemName: item.promptTitle != nil ? "checkmark.seal.fill" : "checkmark.circle.fill")
                                    .font(.system(size: 11, weight: .bold))
                                Text(item.label)
                                    .font(.caption.weight(.semibold))
                            }
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(celebrating?.id == item.id ? HWTheme.tape : HWTheme.moss)
                            .foregroundStyle(celebrating?.id == item.id ? HWTheme.ink : HWTheme.paper)
                            .clipShape(Capsule())
                            .scaleEffect(celebrating?.id == item.id ? 1.12 : 1)
                            .transition(.scale(scale: 0.4).combined(with: .opacity))
                        }
                        Text("\(session.capturedItems.count) captured")
                            .font(.caption2)
                            .foregroundStyle(HWTheme.paper.opacity(0.7))
                            .padding(.leading, 4)
                    }
                    .padding(.vertical, 2)
                }
                .accessibilityIdentifier("captured-chips")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .animation(.spring(response: 0.35, dampingFraction: 0.6), value: session.capturedItems.count)
        .animation(.easeOut(duration: 0.2), value: speech.partialText)
    }

    /// Everything to show, as chips, in any order. Only your voice ticks them:
    /// say the name of the thing while it's on screen.
    private var promptRow: some View {
        let done = session.checklist.filter(\.done).count
        let total = session.checklist.count
        return VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Text("\(done)/\(total)")
                        .font(.system(.caption2, design: .rounded).weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(done == total ? HWTheme.moss : HWTheme.brass)
                        .padding(.trailing, 2)
                    ForEach(session.checklist) { item in
                        let pulsing = pulsingPrompt == item.title
                        Button {
                            promptHint = item.prompt?.ask ?? item.title
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if promptHint == (item.prompt?.ask ?? item.title) { promptHint = nil } }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 11, weight: .bold))
                                Text(item.title)
                                    .font(.caption.weight(item.done ? .bold : .semibold))
                                    .strikethrough(false)
                            }
                            .padding(.horizontal, 9)
                            .padding(.vertical, 6)
                            .background(item.done ? HWTheme.moss : HWTheme.navy.opacity(0.75))
                            .foregroundStyle(item.done ? HWTheme.paper : HWTheme.paper.opacity(0.85))
                            .overlay(Capsule().stroke(item.done ? HWTheme.moss : HWTheme.paper.opacity(0.35), lineWidth: 1))
                            .clipShape(Capsule())
                            .scaleEffect(pulsing ? 1.15 : 1)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("prompt-\(item.title)")
                        .accessibilityValue(item.done ? "done" : "open")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
            }
            .accessibilityIdentifier("prompt-row")
            if let hint = promptHint {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(HWTheme.paper.opacity(0.9))
                    .padding(.horizontal, 14)
                    .padding(.bottom, 4)
                    .transition(.opacity)
                    .accessibilityIdentifier("prompt-hint")
            }
        }
        .background(HWTheme.navy.opacity(0.88))
        .animation(.spring(response: 0.4, dampingFraction: 0.55), value: pulsingPrompt)
        .animation(.spring(response: 0.4, dampingFraction: 0.7), value: session.checklist.filter(\.done).count)
        .animation(.easeOut(duration: 0.2), value: promptHint)
    }

    private var checklistPeek: some View {
        let remaining = session.checklist.filter { !$0.done }.count
        let total = session.checklist.count
        return Button {
            showChecklist = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checklist")
                    .font(.system(size: 14, weight: .semibold))
                Text("Checklist")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(remaining == 0 ? "All done" : "\(total - remaining) of \(total)")
                    .font(.subheadline)
                    .monospacedDigit()
                Image(systemName: "chevron.up")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(HWTheme.paper.opacity(0.6))
            }
            .foregroundStyle(HWTheme.paper)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(HWTheme.navy.opacity(0.88))
        }
        .accessibilityIdentifier("open-checklist")
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 8) {
            if !session.walkRecording {
                LargeActionButton(
                    title: canStart ? "Start walk" : (floorFound ? "Hold still…" : "Point at the floor"),
                    identifier: "start-walk",
                    fill: HWTheme.brass,
                    enabled: canStart
                ) { startWalk() }
            } else {
                LargeActionButton(
                    title: finishing ? "Saving your walk…" : "Done walking",
                    identifier: "done-walk",
                    fill: HWTheme.stamp.opacity(0.9),
                    textColor: HWTheme.paper,
                    enabled: !finishing
                ) { stopWalk() }
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 18)
        .padding(.top, 8)
        .background(HWTheme.ink.opacity(0.9))
    }

    // MARK: - Sheets

    private var checklistSheet: some View {
        NavigationStack {
            List {
                Section("Insurance inventory") {
                    ForEach(session.checklist.filter { $0.category == "insurance" }) { item in
                        checklistRow(item)
                    }
                }
                Section("Maintenance") {
                    ForEach(session.checklist.filter { $0.category == "maintenance" }) { item in
                        checklistRow(item)
                    }
                }
                Section("Guidebook") {
                    ForEach(session.checklist.filter { $0.category == "guidebook" }) { item in
                        checklistRow(item)
                    }
                }
            }
            .navigationTitle("Say it to tick it")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { showChecklist = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// Status only. Nothing here is tapped off — say the thing's name on the walk.
    private func checklistRow(_ item: ChecklistItem) -> some View {
        let evidence = item.evidenceItemID.flatMap { id in session.capturedItems.first { $0.id == id } }
        return HStack(alignment: .top) {
            Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(item.done ? HWTheme.moss : HWTheme.ink.opacity(0.35))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .foregroundStyle(HWTheme.ink)
                if let evidence {
                    Text("heard “\(evidence.transcript.prefix(70))”")
                        .font(.caption)
                        .foregroundStyle(HWTheme.moss)
                } else if let ask = item.prompt?.ask {
                    Text(ask)
                        .font(.caption)
                        .foregroundStyle(HWTheme.ink.opacity(0.55))
                }
            }
            Spacer()
        }
        .accessibilityIdentifier("checklist-\(item.title)")
    }

    private var scriptSheet: some View {
        NavigationStack {
            List {
                Section("Say this") {
                    ForEach(WalkCopy.scriptBeats, id: \.self) { beat in
                        Text(beat)
                    }
                }
                Section("Insurance") {
                    ForEach(WalkCopy.insuranceItems, id: \.self) { Text($0) }
                }
                Section("Maintenance") {
                    ForEach(WalkCopy.maintenanceItems, id: \.self) { Text($0) }
                }
                Section("Guidebook") {
                    ForEach(WalkCopy.guidebookItems, id: \.self) { Text($0) }
                }
            }
            .navigationTitle("Walk script")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { showScript = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Actions

    private func startWalk() {
        if let replay { replay.start(); return }
        guard let hit = hits.hit() else {
            // On the phone there is no fallback: a made-up floor at the AR
            // origin would sit at chest height and ruin every sample.
            session.setLastError(PlacementError.noFloorFound.description)
            return
        }
        _ = session.beginWalk(hit)
        if session.walkRecording {
            session.setWalkRoomName("Whole walk — awaiting assembly", type: .other)
            UIApplication.shared.isIdleTimerDisabled = true
            ensureMedia()
            recordGeoIfReady()
            if let phrase = app.uiTestHeardPhrase {
                // UI tests cannot speak; they hand us a sentence instead.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { celebrate(session.hear(phrase, isFinal: true)) }
            }
        }
        app.persist()
    }

    /// One GPS fix per capture, taken as soon as a location is available after
    /// the floor is confirmed. The camera position at that moment anchors it.
    private func recordGeoIfReady() {
        guard onDevice, session.floor != nil, session.geo == nil, geo.location != nil else { return }
        let cameraPlan = session.walkPoses.last?.camera ?? .zero
        if let record = geo.record(headingAligned: hits.headingAligned, cameraPlan: cameraPlan) {
            session.setGeo(record)
            app.persist()
        }
    }

    private func stopWalk() {
        if let replay {
            do {
                try replay.finish(store: app.store)
                app.route = .review
                app.persist()
            } catch { session.setLastError("Replay could not be saved: \(error.localizedDescription)") }
            return
        }
        guard !finishing, session.walkRecording else { return }
        sampleIfWalking()
        finishing = true
        checkpointMedia()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Save HomeWalk") {
            session.recordCaptureEvent("saveTimeExpired", detail: "Background time expired; recover playable media on reopening")
            app.store.save(session)
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }
        stopMedia {
            session.stopWalkRecording()
            app.store.save(session)
            UIApplication.shared.isIdleTimerDisabled = false
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
            app.route = .review
            app.persist()
        }
    }

    /// Stand in a doorway you marked earlier and tap: records the distance
    /// between the tracked position and that doorway. Drift evidence.
    private func checkAlignment() {
        sampleIfWalking()
        guard let camera = session.walkPoses.last?.camera ?? hits.lastCameraPlan else {
            session.setLastError("Walk a little first so we know where you are.")
            return
        }
        let result = session.checkAlignment(cameraPlan: camera)
        if result.isOK, let check = session.alignmentChecks.last {
            let door = session.doorways.first { $0.id == check.doorwayID }
            let rooms = door?.connectedRoomIDs.compactMap { id in session.rooms.first { $0.id == id }?.name } ?? []
            alignmentToast = String(
                format: "Door %@: tracked position is %.0f cm from where it was marked.",
                rooms.joined(separator: " ↔ "),
                check.distanceMeters * 100
            )
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { alignmentToast = nil }
        }
        app.persist()
    }

    private func configureLiveLink() {
        live.snapshotProvider = { [weak session, weak video] in
            guard let session else { return nil }
            return Self.snapshot(session: session, video: video)
        }
        live.onSettings = { settings, rebox in
            session.updateSettings(settings, reboxRooms: rebox)
            app.persist()
        }
        live.onCommand = { name in
            switch name {
            case "alignNow": _ = session.alignGridNow()
            case "rebox": session.reboxRooms()
            case "checkDoor" where debugEnabled: checkAlignment()
            default: break
            }
            app.persist()
        }
        if debugEnabled, !liveHost.isEmpty { live.connect(host: liveHost) }
    }

    private static func snapshot(session: CaptureSession, video: WalkVideoRecorder?) -> LiveSnapshot {
        let last = session.walkPoses.last
        let grid = session.gridEstimate
        return LiveSnapshot(
            t: Date().timeIntervalSince1970,
            sessionID: session.document.sessionID,
            name: session.document.name,
            tracking: session.tracking.label,
            phase: session.phase.rawValue,
            walking: session.walkRecording,
            settings: session.settings,
            rooms: session.rooms.map {
                .init(id: $0.id, name: $0.name, type: $0.type.rawValue, polygon: $0.displayPolygon, tape: $0.tapeSize, snap: $0.wallSnapShift)
            },
            doorways: session.doorways.map { .init(a: $0.endpointA, b: $0.endpointB, rooms: $0.connectedRoomIDs) },
            inProgress: .init(
                label: session.currentRoomLabel,
                samples: Array(session.walkSamples.suffix(400)),
                hits: Array(session.walkPoses.suffix(200).compactMap(\.hit)),
                box: session.inProgressDisplayPolygon,
                size: session.inProgressSize.map { Vec2(x: $0.width, y: $0.depth) },
                rawSize: session.inProgressRawSize.map { Vec2(x: $0.width, y: $0.depth) },
                poseCount: session.walkPoses.count,
                lastCameraHeight: last?.cameraHeight,
                lastYawDegrees: last?.yaw.map { $0 * 180 / .pi }
            ),
            grid: .init(angleDegrees: grid.angleDegrees, applied: session.floor?.gridAngle.map { $0 * 180 / .pi }, yawVotes: grid.yawVotes, pathMeters: grid.pathMeters),
            media: .init(videoFrames: video?.stats.appended ?? 0, videoDropped: video?.stats.dropped ?? 0, recording: video?.isRecording ?? false),
            checks: session.alignmentChecks.map(\.distanceMeters),
            mismatches: session.mismatches.map(\.summary),
            prompt: session.nextPrompt?.title,
            promptsDone: session.checklist.filter(\.done).count,
            promptsTotal: session.checklist.count,
            captured: session.capturedItems.suffix(12).map { "\($0.label)" },
            heard: session.transcript.suffix(3).map(\.text),
            footprint: session.footprintPlan,
            geo: session.geo.map { .init(lat: $0.latitude, lon: $0.longitude, accuracy: $0.horizontalAccuracy, headingAligned: $0.headingAligned, trueHeading: $0.trueHeading) },
            siteNote: session.site?.placementNote
        )
    }

    private func configureSpeech() {
        speech.onPartial = { text in
            celebrate(session.hear(text, isFinal: false))
        }
        speech.onFinal = { text, start, end in
            celebrate(session.hear(text, isFinal: true, at: end, startedAt: start))
            app.persist()
        }
    }

    /// New items pop, a haptic fires, and a ticked prompt shows a "got it" card for a moment.
    private func celebrate(_ added: [CapturedItem]) {
        guard let last = added.last else { return }
        let haptic = UINotificationFeedbackGenerator()
        haptic.notificationOccurred(last.promptTitle != nil ? .success : .warning)
        withAnimation(.spring(response: 0.35, dampingFraction: 0.55)) { celebrating = last }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            if celebrating?.id == last.id { withAnimation { celebrating = nil } }
        }
        if let title = added.compactMap(\.promptTitle).last { pulsePrompt(title) }
    }

    /// The chip that was just heard pops for a moment.
    private func pulsePrompt(_ title: String) {
        withAnimation { pulsingPrompt = title }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            if pulsingPrompt == title { withAnimation { pulsingPrompt = nil } }
        }
    }

    private func checkpointMedia() {
        if let audio = speech.audioMediaRecord { session.setMedia(audio) }
        let record = video.mediaSnapshot
        if record.videoStartedAt != nil { session.setMedia(record) }
        app.store.save(session)
    }

    private func stopMedia(completion: @escaping () -> Void) {
        guard didStartMedia else { completion(); return }
        didStartMedia = false
        _ = speech.stop()
        if let audio = speech.audioMediaRecord { session.setMedia(audio) }
        hits.videoRecorder = nil
        app.store.save(session)
        guard onDevice else { completion(); return }
        // Always stop, even if opening failed: preserve and surface the error.
        video.stop { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let record): session.setMedia(record)
                case .failure(let error):
                    session.setLastError("Video could not be finalized: \(error.localizedDescription)")
                    session.recordCaptureEvent("videoFinalizationFailed", detail: error.localizedDescription)
                }
                app.store.save(session)
                completion()
            }
        }
    }

    private func sampleIfWalking() {
        guard replay == nil, session.walkRecording, !finishing, session.phase == .walking else { return }
        // The camera pose is the measurement; the crosshair hit is optional evidence.
        guard let camera = hits.camera() else { return }
        let before = session.walkSamples.count
        _ = session.sampleWalk(camera: camera, hit: hits.hit())
        if session.walkSamples.count != before, session.walkSamples.count % 10 == 0 {
            app.persist()
        }
    }

    private func ensureMedia() {
        let dir = app.store.sessionDirectory(id: session.document.sessionID)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard !didStartMedia else { return }
        didStartMedia = true
        session.beginSpokenNote()
        do {
            try speech.start(fileURL: dir.appendingPathComponent(WalkCopy.audioFilename))
            if let audio = speech.audioMediaRecord { session.setMedia(audio) }
        } catch {
            session.setLastError("Microphone: \(error.localizedDescription)")
        }
        session.setWalkMedia(video: nil, audio: WalkCopy.audioFilename)
        if onDevice {
            // Camera frames come from ARKit; the recorder opens on the first one.
            var pendingVideo = MediaRecord()
            pendingVideo.videoPath = WalkCopy.videoFilename
            session.setMedia(pendingVideo)
            app.store.save(session)
            video.onStarted = { record in
                DispatchQueue.main.async {
                    session.setMedia(record)
                    app.store.save(session)
                }
            }
            video.arm(url: dir.appendingPathComponent(WalkCopy.videoFilename))
            hits.videoRecorder = video
        } else {
            let marker = dir.appendingPathComponent(WalkCopy.videoPlaceholderFilename)
            if !FileManager.default.fileExists(atPath: marker.path) {
                try? WalkCopy.videoPlaceholderBody.write(to: marker, atomically: true, encoding: .utf8)
            }
            session.setWalkMedia(video: WalkCopy.videoPlaceholderFilename, audio: nil)
        }
    }
}
