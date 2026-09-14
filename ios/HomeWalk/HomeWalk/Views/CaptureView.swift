import SwiftUI

/// Retired corner-tap capture path. The product surface is `WalkCaptureView`.
/// Kept so `SimulatorFloorView` and the geometry engine's corner APIs stay
/// available for tests; this view is not presented.
struct CaptureView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var session: CaptureSession
    @StateObject private var hits = HitBridge()
    @State private var showNameSheet = false
    @State private var roomName = ""
    @State private var roomType: RoomType = .other
    @State private var interviewAnswer = ""
    @State private var showMicExplainer = false
    @State private var recorder = SpokenNoteRecorder()
    @State private var selectedEdge = 0
    @State private var doorwayWidth = 0.9
    @State private var approximateCorner = false
    @State private var existingRoomPick: UUID?

    var body: some View {
        ZStack {
            stage
            crosshair
            VStack(spacing: 0) {
                topBar
                instructionBanner
                Spacer()
                HStack(alignment: .bottom) {
                    MiniMapView(session: session)
                        .frame(width: 148, height: 148)
                        .accessibilityIdentifier("mini-map")
                    Spacer()
                }
                .padding(.horizontal, 12)
                if !SpatialCapabilities.worldTrackingSupported {
                    simulatorAim
                }
                if session.phase == .placingDoorway {
                    doorwayBar
                }
                if session.phase == .interviewing || session.phase == .paused, session.currentPrompt != nil {
                    interviewCard
                }
                if let mismatch = session.mismatches.last {
                    Text(mismatch.summary)
                        .font(.footnote)
                        .foregroundStyle(HWTheme.paper)
                        .padding(8)
                        .background(HWTheme.rust)
                        .accessibilityIdentifier("mismatch-banner")
                }
                if let alert = session.floorHeightAlert {
                    Text(alert.message)
                        .font(.footnote)
                        .foregroundStyle(HWTheme.paper)
                        .padding(8)
                        .background(HWTheme.rust)
                        .accessibilityIdentifier("floor-height-alert")
                }
                if let err = session.lastError {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(HWTheme.paper)
                        .padding(8)
                        .background(Color.black.opacity(0.7))
                }
                controlBar
            }
        }
        .ignoresSafeArea(edges: .bottom)
        .sheet(isPresented: $showNameSheet) { nameSheet }
        .alert("Record a spoken note", isPresented: $showMicExplainer) {
            Button("Record") { Task { await startRecording() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("HomeWalk records your spoken answers about this room. The microphone is used only while you record, not in the background.")
        }
        .onChange(of: session.document) { _, _ in
            app.persist()
        }
    }

    private var stage: some View {
        Group {
            if SpatialCapabilities.worldTrackingSupported {
                ARKitCaptureView(session: session, hits: hits)
                    .ignoresSafeArea()
            } else {
                SimulatorFloorView(hits: hits, session: session)
                    .ignoresSafeArea()
            }
        }
    }

    private var crosshair: some View {
        ZStack {
            Rectangle().fill(HWTheme.tape).frame(width: 22, height: 2)
            Rectangle().fill(HWTheme.tape).frame(width: 2, height: 22)
            Circle().stroke(HWTheme.tape, lineWidth: 1.5).frame(width: 28, height: 28)
        }
        .allowsHitTesting(false)
        .accessibilityIdentifier("crosshair")
    }

    private var topBar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.tracking.label)
                    .font(.system(.caption, design: .rounded).weight(.semibold))
                    .accessibilityIdentifier("tracking-indicator")
                Text(session.currentRoomLabel)
                    .font(.headline)
                    .accessibilityIdentifier("current-room-label")
            }
            Spacer()
            Button("Pause") {
                _ = session.pauseCapture()
                app.persist()
            }
            Button("Review") {
                session.goToReview()
                app.route = .review
                app.persist()
            }
            .accessibilityIdentifier("open-review")
        }
        .foregroundStyle(HWTheme.paper)
        .padding(.horizontal, 14)
        .padding(.top, 54)
        .padding(.bottom, 8)
        .background(HWTheme.trackingColor(session.tracking).opacity(0.92))
    }

    private var instructionBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            if session.phase == .awaitingFloor {
                Text(CaptureSession.floorPrompt)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .accessibilityIdentifier("floor-prompt")
            } else {
                Text(session.instruction)
                    .font(.body)
                    .accessibilityIdentifier("instruction")
            }
            if session.phase == .awaitingFloor {
                Text("Confirm the floor itself — not a table or counter.")
                    .font(.footnote)
            }
        }
        .foregroundStyle(HWTheme.paper)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(HWTheme.overlay)
    }

    private var simulatorAim: some View {
        HStack(spacing: 8) {
            TextField("X m", text: $hits.aim.xText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("sim-x")
            TextField("Z m", text: $hits.aim.zText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("sim-z")
            Button("Aim") {
                hits.applyTextFieldsToAim()
            }
            .accessibilityIdentifier("sim-apply-aim")
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(HWTheme.tape)
            .foregroundStyle(HWTheme.ink)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    private var doorwayBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let room = session.rooms.last {
                Picker("Wall", selection: $selectedEdge) {
                    ForEach(0..<max(room.displayPolygon.count, 1), id: \.self) { i in
                        Text("Wall \(i + 1)").tag(i)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("doorway-edge")
                HStack {
                    Text(String(format: "Width %.2f m", doorwayWidth))
                    Slider(value: $doorwayWidth, in: 0.6...1.4, step: 0.05)
                        .accessibilityIdentifier("doorway-width")
                }
                Button("Place doorway") {
                    let poly = room.displayPolygon
                    guard poly.count >= 2 else { return }
                    let a = poly[selectedEdge % poly.count]
                    let b = poly[(selectedEdge + 1) % poly.count]
                    let mid = Vec2(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
                    _ = session.placeDoorwayCenter(
                        roomID: room.id,
                        edgeIndex: selectedEdge % poly.count,
                        center: mid,
                        width: doorwayWidth
                    )
                    app.persist()
                }
                .accessibilityIdentifier("place-doorway")
                HStack {
                    LargeActionButton(
                        title: "Enter new room",
                        identifier: "enter-new-room",
                        fill: HWTheme.tape,
                        enabled: session.pendingDoorway != nil
                    ) {
                        _ = session.enterNewRoom()
                        app.persist()
                    }
                    Menu {
                        ForEach(session.rooms) { room in
                            Button(room.name) {
                                _ = session.returnToExistingRoom(room.id)
                                app.route = .review
                                app.persist()
                            }
                        }
                    } label: {
                        Text("Return to existing room")
                            .font(.system(.body, design: .rounded).weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 56)
                            .background(HWTheme.paper)
                            .foregroundStyle(HWTheme.ink)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .accessibilityIdentifier("return-to-existing-room")
                }
            }
        }
        .padding(12)
        .background(HWTheme.overlay)
        .foregroundStyle(HWTheme.paper)
    }

    private var interviewCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(session.currentPrompt?.text ?? "")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .accessibilityIdentifier("interview-prompt")
            TextField("Type an answer", text: $interviewAnswer)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("interview-answer")
            HStack {
                Button("Answer") {
                    _ = session.answerPrompt(text: interviewAnswer)
                    interviewAnswer = ""
                    app.persist()
                }
                .accessibilityIdentifier("interview-answer-button")
                Button("Skip") {
                    _ = session.skipPrompt()
                    interviewAnswer = ""
                    app.persist()
                }
                .accessibilityIdentifier("interview-skip")
                Button("Dismiss") {
                    _ = session.dismissPrompts()
                    app.persist()
                }
                .accessibilityIdentifier("interview-dismiss")
                Button(recorder.isRecording ? "Stop" : "Record") {
                    if recorder.isRecording {
                        finishRecording()
                    } else if app.micExplainerNeeded {
                        showMicExplainer = true
                        app.micExplainerNeeded = false
                    } else {
                        Task { await startRecording() }
                    }
                }
                .accessibilityIdentifier("interview-record")
            }
            .buttonStyle(.borderedProminent)
            .tint(HWTheme.tape)
            .foregroundStyle(HWTheme.ink)
        }
        .padding(12)
        .background(HWTheme.paper)
        .padding(.horizontal, 8)
    }

    private var controlBar: some View {
        VStack(spacing: 8) {
            Toggle("Approximate corner (hidden wall)", isOn: $approximateCorner)
                .tint(HWTheme.tape)
                .foregroundStyle(HWTheme.paper)
                .padding(.horizontal, 4)
            Toggle("Right-angle snap", isOn: Binding(
                get: { session.snapEnabled },
                set: { session.setSnapEnabled($0); app.persist() }
            ))
            .tint(HWTheme.tape)
            .foregroundStyle(HWTheme.paper)
            .accessibilityIdentifier("snap-toggle")
            HStack(spacing: 8) {
                if session.phase == .awaitingFloor {
                    LargeActionButton(
                        title: "Confirm floor",
                        identifier: "confirm-floor",
                        fill: HWTheme.tape,
                        enabled: session.canPlace
                    ) { confirmFloor() }
                }
                LargeActionButton(
                    title: "Add corner",
                    identifier: "add-corner",
                    fill: HWTheme.tape,
                    enabled: session.canPlace && session.phase == .outliningRoom
                ) { addCorner() }
                LargeActionButton(
                    title: "Undo",
                    identifier: "undo",
                    fill: HWTheme.paper
                ) {
                    _ = session.undo()
                    app.persist()
                }
                LargeActionButton(
                    title: "Finish room",
                    identifier: "finish-room",
                    fill: Color(red: 0.72, green: 0.82, blue: 0.90),
                    enabled: session.phase == .outliningRoom && session.inProgressPoints.count >= 3
                ) {
                    roomName = session.currentRoomLabel
                    showNameSheet = true
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 18)
        .padding(.top, 8)
        .background(HWTheme.ink.opacity(0.88))
    }

    private var nameSheet: some View {
        NavigationStack {
            Form {
                TextField("Room name", text: $roomName)
                    .accessibilityIdentifier("room-name-field")
                Picker("Type", selection: $roomType) {
                    ForEach(RoomType.allCases) { type in
                        Text(type.displayName).tag(type)
                    }
                }
                .accessibilityIdentifier("room-type")
            }
            .navigationTitle("Finish room")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        _ = session.finishRoom(name: roomName, type: roomType)
                        showNameSheet = false
                        app.persist()
                    }
                    .accessibilityIdentifier("confirm-room-name")
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showNameSheet = false }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func confirmFloor() {
        guard let hit = hits.hit() else { return }
        _ = session.confirmFloor(hit)
        app.persist()
    }

    private func addCorner() {
        guard let hit = hits.hit() else { return }
        _ = session.addCorner(hit, approximate: approximateCorner)
        app.persist()
    }

    private func startRecording() async {
        let allowed = await recorder.requestPermission()
        guard allowed, let id = session.document.sessionID as UUID? else { return }
        session.beginSpokenNote()
        let dir = app.store.sessionDirectory(id: id)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? recorder.start(in: dir)
    }

    private func finishRecording() {
        guard let url = recorder.stop() else { return }
        let relative = url.lastPathComponent
        _ = session.answerPrompt(text: interviewAnswer, audioRelativePath: relative)
        interviewAnswer = ""
        app.persist()
    }
}

struct SimulatorFloorView: View {
    @ObservedObject var hits: HitBridge
    @ObservedObject var session: CaptureSession

    var body: some View {
        GeometryReader { geo in
            let map = SimulatorFloorMap(canvasSize: geo.size)
            Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(red: 0.18, green: 0.20, blue: 0.16)))
            let map = SimulatorFloorMap(canvasSize: size)
            func pt(_ v: Vec2) -> CGPoint { map.toScreen(v) }
            var grid = Path()
            for i in -5...5 {
                let m = Double(i)
                grid.move(to: pt(Vec2(x: m, y: -5)))
                grid.addLine(to: pt(Vec2(x: m, y: 5)))
                grid.move(to: pt(Vec2(x: -5, y: m)))
                grid.addLine(to: pt(Vec2(x: 5, y: m)))
            }
            context.stroke(grid, with: .color(.white.opacity(0.12)), lineWidth: 1)
            for room in session.rooms {
                var path = Path()
                let poly = room.displayPolygon
                guard let first = poly.first else { continue }
                path.move(to: pt(first))
                for p in poly.dropFirst() { path.addLine(to: pt(p)) }
                path.closeSubpath()
                context.fill(path, with: .color(HWTheme.blueprint.opacity(0.35)))
                context.stroke(path, with: .color(HWTheme.paper), lineWidth: 2)
            }
            let live = session.inProgressDisplayPolygon
            if let first = live.first {
                var path = Path()
                path.move(to: pt(first))
                for p in live.dropFirst() { path.addLine(to: pt(p)) }
                context.stroke(path, with: .color(HWTheme.tape), lineWidth: 3)
                for p in live {
                    let r = CGRect(x: pt(p).x - 4, y: pt(p).y - 4, width: 8, height: 8)
                    context.fill(Path(ellipseIn: r), with: .color(HWTheme.tape))
                }
            }
            let aim = pt(Vec2(x: hits.aim.x, y: hits.aim.z))
            context.stroke(
                Path(ellipseIn: CGRect(x: aim.x - 8, y: aim.y - 8, width: 16, height: 16)),
                with: .color(HWTheme.tape),
                lineWidth: 2
            )
            }
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                let plan = map.toPlan(value.location)
                hits.setSimAim(x: plan.x, z: plan.y)
            })
            .accessibilityIdentifier("simulator-floor")
        }
    }
}
