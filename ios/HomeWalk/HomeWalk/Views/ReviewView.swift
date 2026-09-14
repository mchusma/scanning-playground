import PhotosUI
import SceneKit
import SwiftUI

struct ReviewView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var session: CaptureSession
    @State private var selectedRoomID: UUID?
    @State private var showShare = false
    @State private var showAssistant = false
    @State private var exportURL: URL?
    @State private var show3D = false
    @State private var showTrail = true
    @State private var renameText = ""
    @State private var noteText = ""
    @State private var tapeWidth = ""
    @State private var tapeDepth = ""
    @State private var photoItem: PhotosPickerItem?

    var selectedRoom: Room? {
        session.rooms.first { $0.id == selectedRoomID } ?? session.rooms.first
    }

    var body: some View {
        NavigationStack {
            ZStack {
                HWTheme.paper.ignoresSafeArea()
                VStack(spacing: 0) {
                    if let replay = app.replay {
                        HStack {
                            Text("Replay result · \(replay.timeline.consumedPoses) poses · \(session.capturedItems.count) items")
                                .font(.caption.weight(.semibold))
                                .accessibilityIdentifier("replay-result")
                            Spacer()
                            Button("Replay again") {
                                replay.seek(to: 0)
                                app.route = .capture
                            }
                            .accessibilityIdentifier("replay-again")
                        }
                        .padding(12)
                    }
                    if let error = session.lastError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(HWTheme.stamp)
                            .padding(12)
                    }
                    if session.rooms.count == 1, session.rooms.first?.name == "Whole walk — awaiting assembly" {
                        Text("Capture saved. This outline shows where you walked; rooms will be assembled after processing.")
                            .font(.footnote)
                            .padding(12)
                    }
                    ZStack(alignment: .topTrailing) {
                        if show3D {
                            Cutaway3DView(session: session)
                                .accessibilityIdentifier("cutaway-3d")
                        } else {
                            PlanEditorView(session: session, selectedRoomID: $selectedRoomID, showTrail: showTrail)
                                .accessibilityIdentifier("plan-editor")
                        }
                        if !show3D {
                            Button {
                                showTrail.toggle()
                            } label: {
                                Label(showTrail ? "Path on" : "Path off", systemImage: "figure.walk")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(HWTheme.paper.opacity(0.9))
                                    .foregroundStyle(HWTheme.navy)
                                    .clipShape(Capsule())
                            }
                            .padding(10)
                            .accessibilityIdentifier("toggle-trail")
                        }
                    }
                    .frame(maxHeight: .infinity)
                    ScrollView {
                        inspector
                    }
                    .frame(maxHeight: 340)
                    .background(HWTheme.paper)
                }
            }
            .navigationTitle("Walkthrough")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Captures") { app.closeToList() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(show3D ? "2D" : "3D") { show3D.toggle() }
                        .accessibilityIdentifier("toggle-3d")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Undo") {
                        _ = session.undo()
                        app.persist()
                    }
                    .accessibilityIdentifier("review-undo")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Export") { export() }
                        .accessibilityIdentifier("export")
                }
            }
            .sheet(isPresented: $showAssistant) { PlanAssistantView(session: session).environmentObject(app) }
            .sheet(isPresented: $showShare) {
                if let exportURL {
                    ActivityView(items: [exportURL])
                }
            }
            .onAppear {
                selectedRoomID = session.rooms.first?.id
                syncFields()
            }
            .onChange(of: selectedRoomID) { _, _ in syncFields() }
            .onChange(of: session.document) { _, _ in
                syncFields()
                app.persist()
            }
        }
    }

    private func syncFields() {
        guard let room = selectedRoom else { return }
        renameText = room.name
        tapeWidth = room.tapeSize.map { String(format: "%.2f", $0.x) } ?? ""
        tapeDepth = room.tapeSize.map { String(format: "%.2f", $0.y) } ?? ""
    }

    // MARK: - Inspector

    private var inspector: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let mismatch = session.mismatches.last {
                Label(mismatch.summary, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(HWTheme.rust.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            Button {
                showAssistant = true
            } label: {
                Label("Adjust plan or ask for changes", systemImage: "bubble.left.and.text.bubble.right")
                    .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(12)
                    .background(HWTheme.moss).foregroundStyle(HWTheme.paper).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .accessibilityIdentifier("open-plan-assistant")
            if session.document.planReview?.kind == "proposal" {
                Text("Proposed layout · hypothetical changes to your captured home").font(.footnote).foregroundStyle(HWTheme.stamp)
            }
            roomChips
            if let room = selectedRoom {
                roomDetail(room)
            }
            recordStrip
            Button {
                app.startNewCapture()
            } label: {
                Label("Start another walk", systemImage: "figure.walk")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(HWTheme.navy)
            .accessibilityIdentifier("continue-capture")
        }
        .padding(12)
    }

    private var roomChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(session.rooms) { room in
                    Button {
                        selectedRoomID = room.id
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(room.name)
                                .font(.subheadline.weight(.semibold))
                            Text(room.sizeLabel)
                                .font(.caption2)
                                .monospacedDigit()
                                .opacity(0.75)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(room.id == selectedRoomID ? HWTheme.tape : HWTheme.ink.opacity(0.08))
                        .foregroundStyle(HWTheme.ink)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .accessibilityIdentifier("select-room-\(room.name)")
                }
            }
        }
    }

    private func roomDetail(_ room: Room) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                TextField("Name", text: $renameText)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("rename-room")
                Button("Rename") {
                    _ = session.renameRoom(id: room.id, name: renameText)
                    app.persist()
                }
                .font(.subheadline.weight(.semibold))
                .accessibilityIdentifier("apply-rename")
            }

            // Measurement row: what we measured, what the tape says.
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 14) {
                    measure("Measured", room.sizeLabel)
                    if let s = room.size {
                        measure("Area", String(format: "%.1f m²", s.width * s.depth))
                    }
                    measure("Doors", "\(session.doorways.filter { $0.connectedRoomIDs.contains(room.id) }.count)")
                }
                HStack(spacing: 6) {
                    Text("Tape")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HWTheme.ink.opacity(0.6))
                        .frame(width: 52, alignment: .leading)
                    TextField("width", text: $tapeWidth)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 72)
                        .accessibilityIdentifier("tape-width")
                    Text("×").foregroundStyle(HWTheme.ink.opacity(0.5))
                    TextField("depth", text: $tapeDepth)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 72)
                        .accessibilityIdentifier("tape-depth")
                    Text("m").foregroundStyle(HWTheme.ink.opacity(0.5))
                    Button("Save") {
                        _ = session.setTapeSize(id: room.id, width: Double(tapeWidth), depth: Double(tapeDepth))
                        app.persist()
                    }
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("save-tape")
                    if let tape = room.tapeSize, let s = room.size {
                        let ew = (s.width - tape.x) / tape.x * 100
                        let ed = (s.depth - tape.y) / tape.y * 100
                        Text(String(format: "%+.0f%% / %+.0f%%", ew, ed))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(max(abs(ew), abs(ed)) <= 10 ? HWTheme.moss : HWTheme.rust)
                            .accessibilityIdentifier("tape-error")
                    }
                }
                if room.isApproximate {
                    Text(
                        room.wallSnapShift.map { String(format: "Box from your walk, aligned to the first room. Shared wall snapped %.0f cm. Drag a corner if a wall is wrong.", $0 * 100) }
                            ?? "Box from your walk, aligned to the first room. Drag a corner if a wall is wrong."
                    )
                    .font(.caption)
                    .foregroundStyle(HWTheme.ink.opacity(0.65))
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HWTheme.navy.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            let notes = session.observations.filter { $0.roomID == room.id || ($0.spanningTransition && $0.roomID == nil) }
            if !notes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(notes) { note in
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: note.source == .photo ? "photo" : (note.source == .spoken ? "waveform" : "text.alignleft"))
                                .font(.caption)
                                .foregroundStyle(HWTheme.ink.opacity(0.5))
                            Text((note.spanningTransition ? "Uncertain · " : "") + note.text)
                                .font(.footnote)
                                .foregroundStyle(note.spanningTransition ? HWTheme.rust : HWTheme.ink)
                        }
                    }
                }
            }
            HStack {
                TextField("Add a note", text: $noteText)
                    .textFieldStyle(.roundedBorder)
                Button("Save note") {
                    session.prepareNote(on: room.id)
                    _ = session.answerPrompt(text: noteText)
                    noteText = ""
                    app.persist()
                }
                .font(.subheadline.weight(.semibold))
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Image(systemName: "camera")
                }
                .onChange(of: photoItem) { _, item in
                    Task { await attachPhoto(item, roomID: room.id) }
                }
            }
        }
    }

    private func measure(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HWTheme.ink.opacity(0.55))
            Text(value)
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(HWTheme.ink)
        }
    }

    private var videoLabel: (text: String, icon: String) {
        if let m = session.media, let start = m.videoStartedAt, m.videoPath != nil {
            let secs = Int((m.videoEndedAt ?? start) - start)
            var text = String(format: "Video %d:%02d · %d frames", secs / 60, secs % 60, m.videoFrames)
            if m.videoDroppedFrames > 0 { text += " (\(m.videoDroppedFrames) dropped)" }
            return (text, "video")
        }
        return ("Video not captured", "video.slash")
    }

    private var recordStrip: some View {
        let remaining = session.checklist.filter { !$0.done }.count
        let hasAudio = session.document.inProgress.audioRelativePath != nil
        let video = videoLabel
        return VStack(alignment: .leading, spacing: 6) {
            Text("Record of the walk")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HWTheme.navy)
            HStack(spacing: 14) {
                Label(hasAudio ? "Audio saved" : "No audio", systemImage: hasAudio ? "waveform" : "waveform.slash")
                    .accessibilityIdentifier("review-audio")
                Label(video.text, systemImage: video.icon)
                    .accessibilityIdentifier("review-video")
                Label(remaining == 0 ? "Checklist done" : "\(remaining) to show", systemImage: "checklist")
                    .accessibilityIdentifier("review-checklist")
            }
            .font(.caption)
            .foregroundStyle(HWTheme.ink.opacity(0.75))
            if !session.alignmentChecks.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(session.alignmentChecks) { check in
                        let names = session.doorways.first { $0.id == check.doorwayID }?
                            .connectedRoomIDs.compactMap { id in session.rooms.first { $0.id == id }?.name }
                            .joined(separator: " ↔ ") ?? "door"
                        Text(String(format: "Door check · %@ · %.0f cm off", names, check.distanceMeters * 100))
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(check.distanceMeters <= 0.25 ? HWTheme.moss : HWTheme.rust)
                    }
                }
                .accessibilityIdentifier("alignment-checks")
            }
            let done = session.checklist.filter(\.done)
            if !done.isEmpty {
                Text(done.map(\.title).joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(HWTheme.moss)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HWTheme.navy.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func export() {
        do {
            exportURL = try app.exportCurrent()
            showShare = true
        } catch {
            session.setLastError(error.localizedDescription)
        }
    }

    private func attachPhoto(_ item: PhotosPickerItem?, roomID: UUID) async {
        guard let item,
              let data = try? await item.loadTransferable(type: Data.self)
        else { return }
        let dir = app.store.sessionDirectory(id: session.document.sessionID)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = "photo-\(UUID().uuidString).jpg"
        let url = dir.appendingPathComponent(name)
        try? data.write(to: url)
        session.prepareNote(on: roomID)
        _ = session.answerPrompt(text: "Photo", photoRelativePath: name)
        app.persist()
    }
}

struct PlanEditorView: View {
    @ObservedObject var session: CaptureSession
    @Binding var selectedRoomID: UUID?
    var showTrail: Bool = true
    @State private var dragIndex: Int?

    var body: some View {
        GeometryReader { geo in
            let pts = session.rooms.flatMap(\.displayPolygon) + (session.footprintPlan ?? [])
            let layout = PlanCanvasLayout.fitting(points: pts, canvasSize: geo.size, rotation: session.geo?.headingAligned == true ? session.floor?.gridAngle ?? 0 : 0)
            ZStack {
                HWTheme.ink.opacity(0.04)
                Canvas { context, _ in
                    // Metre grid, aligned to the plan (which is aligned to the first room's walls).
                    let corners = [CGPoint.zero, CGPoint(x: geo.size.width, y: 0),
                                   CGPoint(x: 0, y: geo.size.height), CGPoint(x: geo.size.width, y: geo.size.height)]
                    let gridBounds = Geometry.bounds(corners.map(layout.toPlan))!
                    let gMin = gridBounds.min, gMax = gridBounds.max
                    var grid = Path()
                    var gx = floor(gMin.x)
                    while gx <= gMax.x {
                        grid.move(to: layout.toScreen(Vec2(x: gx, y: gMin.y)))
                        grid.addLine(to: layout.toScreen(Vec2(x: gx, y: gMax.y)))
                        gx += 1
                    }
                    var gy = floor(gMin.y)
                    while gy <= gMax.y {
                        grid.move(to: layout.toScreen(Vec2(x: gMin.x, y: gy)))
                        grid.addLine(to: layout.toScreen(Vec2(x: gMax.x, y: gy)))
                        gy += 1
                    }
                    context.stroke(grid, with: .color(HWTheme.ink.opacity(0.06)), lineWidth: 1)

                    if let fp = session.footprintPlan, let first = fp.first {
                        var path = Path()
                        path.move(to: layout.toScreen(first))
                        for p in fp.dropFirst() { path.addLine(to: layout.toScreen(p)) }
                        path.closeSubpath()
                        context.fill(path, with: .color(Color.teal.opacity(0.08)))
                        context.stroke(path, with: .color(Color.teal), style: StrokeStyle(lineWidth: 2.5))
                    }

                    for room in session.rooms {
                        var path = Path()
                        let poly = room.displayPolygon
                        guard let first = poly.first else { continue }
                        path.move(to: layout.toScreen(first))
                        for p in poly.dropFirst() { path.addLine(to: layout.toScreen(p)) }
                        path.closeSubpath()
                        let selected = room.id == selectedRoomID
                        context.fill(path, with: .color((selected ? HWTheme.tape : HWTheme.blueprint).opacity(0.28)))
                        context.stroke(path, with: .color(HWTheme.ink), lineWidth: selected ? 3 : 1.5)

                        if showTrail, selected, room.walkTrail.count >= 2 {
                            var trail = Path()
                            trail.move(to: layout.toScreen(room.walkTrail[0]))
                            for p in room.walkTrail.dropFirst() { trail.addLine(to: layout.toScreen(p)) }
                            context.stroke(trail, with: .color(HWTheme.stamp.opacity(0.8)), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                        }

                        // Name + dimensions
                        if let b = Geometry.bounds(poly) {
                            let c = layout.toScreen(Vec2(x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2))
                            context.draw(
                                Text(room.name).font(.system(size: 12, weight: .semibold, design: .serif)).foregroundStyle(HWTheme.ink),
                                at: CGPoint(x: c.x, y: c.y - 8)
                            )
                            context.draw(
                                Text(room.sizeLabel).font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(HWTheme.ink.opacity(0.7)),
                                at: CGPoint(x: c.x, y: c.y + 8)
                            )
                            let w = b.max.x - b.min.x
                            let d = b.max.y - b.min.y
                            let top = layout.toScreen(Vec2(x: (b.min.x + b.max.x) / 2, y: b.min.y))
                            let left = layout.toScreen(Vec2(x: b.min.x, y: (b.min.y + b.max.y) / 2))
                            context.draw(
                                Text(String(format: "%.1f", w)).font(.system(size: 9, design: .rounded)).foregroundStyle(HWTheme.ink.opacity(0.6)),
                                at: CGPoint(x: top.x, y: top.y - 9)
                            )
                            context.draw(
                                Text(String(format: "%.1f", d)).font(.system(size: 9, design: .rounded)).foregroundStyle(HWTheme.ink.opacity(0.6)),
                                at: CGPoint(x: left.x - 12, y: left.y)
                            )
                        }
                    }
                    for door in session.doorways {
                        var path = Path()
                        path.move(to: layout.toScreen(door.endpointA))
                        path.addLine(to: layout.toScreen(door.endpointB))
                        context.stroke(path, with: .color(HWTheme.paper), lineWidth: 7)
                        context.stroke(path, with: .color(HWTheme.brass), lineWidth: 3)
                    }
                }
                if session.geo?.headingAligned == true {
                    VStack { HStack { Text("↑ N").font(.caption.bold()).padding(10); Spacer() }; Spacer() }
                        .allowsHitTesting(false)
                }
                ForEach(session.rooms) { room in
                    ForEach(Array(room.displayPolygon.enumerated()), id: \.offset) { index, point in
                        let screen = layout.toScreen(point)
                        let selected = room.id == selectedRoomID
                        Circle()
                            .fill(selected ? HWTheme.tape : HWTheme.ink.opacity(0.7))
                            .overlay(Circle().stroke(HWTheme.paper, lineWidth: 2))
                            .frame(width: selected ? 22 : 14, height: selected ? 22 : 14)
                            .position(screen)
                            .gesture(
                                DragGesture(minimumDistance: 0, coordinateSpace: .named("plan-canvas"))
                                    .onChanged { value in
                                        selectedRoomID = room.id
                                        _ = session.adjustCorner(
                                            roomID: room.id,
                                            index: index,
                                            to: layout.toPlan(value.location)
                                        )
                                    }
                            )
                    }
                }
            }
            .coordinateSpace(.named("plan-canvas"))
            .accessibilityIdentifier("plan-canvas")
        }
    }
}

struct MiniMapView: View {
    @ObservedObject var session: CaptureSession
    var captureOnly = false

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(HWTheme.ink.opacity(0.82)))
            var pts = (captureOnly ? session.walkPoses.map(\.camera) : session.rooms.flatMap(\.displayPolygon) + session.inProgressDisplayPolygon) + (session.footprintPlan ?? [])
            if pts.isEmpty { pts = [Vec2.zero] }
            let headingAligned = session.geo?.headingAligned == true
            let layout = PlanCanvasLayout.fitting(points: pts, canvasSize: size, pad: 0.8,
                                                  rotation: headingAligned ? session.floor?.gridAngle ?? 0 : 0)
            func pt(_ p: Vec2) -> CGPoint { layout.toScreen(p) }
            if let fp = session.footprintPlan, let first = fp.first {
                var path = Path()
                path.move(to: pt(first))
                for p in fp.dropFirst() { path.addLine(to: pt(p)) }
                path.closeSubpath()
                context.fill(path, with: .color(Color.teal.opacity(0.12)))
                context.stroke(path, with: .color(Color.teal), lineWidth: 2)
            }
            for room in (captureOnly ? [] : session.rooms) {
                var path = Path()
                guard let first = room.displayPolygon.first else { continue }
                path.move(to: pt(first))
                for p in room.displayPolygon.dropFirst() { path.addLine(to: pt(p)) }
                path.closeSubpath()
                context.fill(path, with: .color(HWTheme.blueprint.opacity(0.5)))
                context.stroke(path, with: .color(HWTheme.paper), lineWidth: 1)
            }
            for door in session.doorways {
                var path = Path()
                path.move(to: pt(door.endpointA))
                path.addLine(to: pt(door.endpointB))
                context.stroke(path, with: .color(HWTheme.brass), lineWidth: 2)
            }
            let trail = session.walkPoses.map(\.camera)
            if let first = trail.first {
                var path = Path()
                path.move(to: pt(first))
                for p in trail.dropFirst() { path.addLine(to: pt(p)) }
                context.stroke(path, with: .color(HWTheme.stamp.opacity(0.85)), lineWidth: 1.5)
            }
            let live = captureOnly ? [] : session.inProgressDisplayPolygon
            if let first = live.first {
                var path = Path()
                path.move(to: pt(first))
                for p in live.dropFirst() { path.addLine(to: pt(p)) }
                if session.phase == .walking { path.closeSubpath() }
                context.stroke(path, with: .color(HWTheme.tape), lineWidth: 2)
            }
            let poses = session.rooms.flatMap(\.walkPoses) + session.walkPoses
            if let start = poses.first?.camera {
                let c = pt(start)
                context.stroke(Path(ellipseIn: CGRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10)),
                               with: .color(HWTheme.tape), lineWidth: 2)
                context.draw(Text("Start").font(.system(size: 8, weight: .semibold)).foregroundStyle(HWTheme.tape),
                             at: CGPoint(x: c.x, y: c.y - 11))
            }
            if let pose = poses.last {
                let c = pt(pose.camera)
                if let yaw = pose.yaw {
                    let ahead = pt(pose.camera + Vec2(x: cos(yaw), y: sin(yaw)))
                    let length = max(0.001, hypot(ahead.x - c.x, ahead.y - c.y))
                    let dx = (ahead.x - c.x) / length, dy = (ahead.y - c.y) / length
                    var arrow = Path()
                    arrow.move(to: CGPoint(x: c.x + dx * 12, y: c.y + dy * 12))
                    arrow.addLine(to: CGPoint(x: c.x - dy * 5, y: c.y + dx * 5))
                    arrow.addLine(to: CGPoint(x: c.x + dy * 5, y: c.y - dx * 5))
                    arrow.closeSubpath()
                    context.fill(arrow, with: .color(HWTheme.paper.opacity(0.85)))
                }
                context.fill(Path(ellipseIn: CGRect(x: c.x - 3, y: c.y - 3, width: 6, height: 6)), with: .color(HWTheme.paper))
            }
            if headingAligned {
                context.draw(Text("↑ N").font(.system(size: 10, weight: .bold)).foregroundStyle(HWTheme.paper),
                             at: CGPoint(x: size.width - 17, y: 12))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(HWTheme.tape, lineWidth: 1))
    }
}

struct Cutaway3DView: UIViewRepresentable {
    @ObservedObject var session: CaptureSession

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = UIColor(red: 0.96, green: 0.94, blue: 0.89, alpha: 1)
        view.allowsCameraControl = true
        view.autoenablesDefaultLighting = true
        view.scene = makeScene()
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
        uiView.scene = makeScene()
    }

    private func makeScene() -> SCNScene {
        let scene = SCNScene()
        let extruded = session.extrudedFootprints()
        let palette: [UIColor] = [
            UIColor(red: 0.12, green: 0.31, blue: 0.52, alpha: 1),
            UIColor(red: 0.72, green: 0.29, blue: 0.16, alpha: 1),
            UIColor(red: 0.31, green: 0.52, blue: 0.33, alpha: 1)
        ]
        for (i, room) in extruded.enumerated() {
            let color = palette[i % palette.count]
            let floor = polygonNode(room.footprint, y: 0, color: color.withAlphaComponent(0.35))
            scene.rootNode.addChildNode(floor)
            for e in 0..<room.footprint.count {
                let a = room.footprint[e]
                let b = room.footprint[(e + 1) % room.footprint.count]
                scene.rootNode.addChildNode(wall(from: a, to: b, height: room.height, color: color))
            }
        }
        // Frame the whole plan, wherever it sits in the AR world.
        let all = extruded.flatMap(\.footprint)
        let b = Geometry.bounds(all) ?? (min: Vec2(x: -2, y: -2), max: Vec2(x: 2, y: 2))
        let center = SCNVector3((b.min.x + b.max.x) / 2, 0, (b.min.y + b.max.y) / 2)
        let span = max(4, max(b.max.x - b.min.x, b.max.y - b.min.y))
        let camera = SCNNode()
        camera.camera = SCNCamera()
        camera.camera?.zFar = 200
        camera.position = SCNVector3(
            Float(center.x) + Float(span) * 0.6,
            Float(span) * 1.1,
            Float(center.z) + Float(span) * 1.2
        )
        camera.look(at: center)
        scene.rootNode.addChildNode(camera)
        return scene
    }

    private func polygonNode(_ poly: [Vec2], y: Double, color: UIColor) -> SCNNode {
        guard poly.count >= 3 else { return SCNNode() }
        let vertices: [SCNVector3] = poly.map { SCNVector3($0.x, y, $0.y) }
        var indices: [Int32] = []
        for i in 1..<(poly.count - 1) {
            indices.append(contentsOf: [0, Int32(i), Int32(i + 1)])
        }
        let src = SCNGeometrySource(vertices: vertices)
        let data = Data(bytes: indices, count: indices.count * MemoryLayout<Int32>.size)
        let element = SCNGeometryElement(data: data, primitiveType: .triangles, primitiveCount: indices.count / 3, bytesPerIndex: MemoryLayout<Int32>.size)
        let geom = SCNGeometry(sources: [src], elements: [element])
        geom.firstMaterial?.diffuse.contents = color
        geom.firstMaterial?.isDoubleSided = true
        return SCNNode(geometry: geom)
    }

    private func wall(from a: Vec2, to b: Vec2, height: Double, color: UIColor) -> SCNNode {
        let dx = b.x - a.x
        let dz = b.y - a.y
        let length = hypot(dx, dz)
        let box = SCNBox(width: CGFloat(length), height: CGFloat(height), length: 0.08, chamferRadius: 0)
        box.firstMaterial?.diffuse.contents = color
        let node = SCNNode(geometry: box)
        node.position = SCNVector3((a.x + b.x) / 2, height / 2, (a.y + b.y) / 2)
        node.eulerAngles.y = Float(atan2(dx, dz))
        return node
    }
}

struct ActivityView: UIViewControllerRepresentable {
    var items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
