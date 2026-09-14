import SwiftUI

/// Numbers behind the walk, overlaid on the capture screen. Debug only.
struct DebugHUDView: View {
    @ObservedObject var session: CaptureSession
    @ObservedObject var live: LiveLink
    var videoStats: WalkVideoRecorder.Stats?
    var onTune: () -> Void
    var onMap: () -> Void

    private func f(_ v: Double?, _ d: Int = 2) -> String {
        guard let v else { return "—" }
        return String(format: "%.\(d)f", v)
    }

    var body: some View {
        let last = session.walkPoses.last
        let grid = session.gridEstimate
        let raw = session.inProgressRawSize
        let size = session.inProgressSize
        VStack(alignment: .leading, spacing: 3) {
            row("track", session.tracking.label)
            row("cam h", last.map { String(format: "%.2f m", $0.cameraHeight) } ?? "—")
            row("yaw", last?.yaw.map { String(format: "%.0f°", $0 * 180 / .pi) } ?? "—")
            row("hit", last?.hit.map { String(format: "%.1f m ahead", $0.distance(to: last!.camera)) } ?? "none")
            row("poses", "\(session.walkPoses.count) · \(session.walkSamples.count) pts")
            row("walked", raw.map { String(format: "%.1f × %.1f", $0.width, $0.depth) } ?? "—")
            row("box", size.map { String(format: "%.1f × %.1f  pad %.2f", $0.width, $0.depth, session.settings.pad) } ?? "—")
            row("grid", (session.floor?.gridAngle).map { String(format: "%.1f° set", $0 * 180 / .pi) }
                ?? (grid.angleDegrees.map { String(format: "%.1f° est", $0) } ?? "no estimate")
                + String(format: " · %d yaw · %.0f m", grid.yawVotes, grid.pathMeters))
            if let v = videoStats {
                row("video", "\(v.appended) fr · \(v.dropped) drop · \(v.throttled) thr")
            }
            row("geo", session.geo.map { String(format: "±%.0f m%@", $0.horizontalAccuracy, $0.headingAligned ? " · compass" : "") } ?? "no fix")
            row("site", session.site.map { $0.placementNote ?? "loaded, not placed" } ?? "none")
            row("link", live.status + (live.connected ? " ↑\(live.sent) ↓\(live.received)" : ""))
            HStack(spacing: 8) {
                Button("Tune", action: onTune)
                Button("Map", action: onMap)
                Button("Align") { _ = session.alignGridNow() }
                Button("Re-box") { session.reboxRooms() }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(HWTheme.tape)
            .padding(.top, 2)
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(HWTheme.paper)
        .padding(8)
        .background(HWTheme.ink.opacity(0.78))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("debug-hud")
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(k).foregroundStyle(HWTheme.tape).frame(width: 44, alignment: .leading)
            Text(v)
        }
    }
}

/// Sliders for the tunables. Commits on release so undo stays sane; the
/// in-progress box redraws from stored poses immediately.
struct TuneSheet: View {
    @ObservedObject var session: CaptureSession
    @ObservedObject var live: LiveLink
    @Binding var liveHost: String
    @Binding var siteAddress: String
    var onPersist: () -> Void
    @State private var siteStatus = ""
    @Environment(\.dismiss) private var dismiss
    @State private var draft: CaptureSettings = .standard
    @State private var overrideOn = false
    @State private var overrideDeg = 0.0

    var body: some View {
        NavigationStack {
            Form {
                Section("Room box") {
                    slider("Pad to walls", $draft.pad, 0.1...1.0, "%.2f m")
                    slider("Min side", $draft.minSide, 0.6...2.5, "%.1f m")
                    Toggle("Measure from crosshair hits (old)", isOn: $draft.measureFromHits)
                        .onChange(of: draft.measureFromHits) { _, _ in commit() }
                    slider("Shared-wall snap max", $draft.sharedWallMaxShift, 0.2...2.0, "%.1f m")
                }
                Section("Crosshair evidence") {
                    slider("Min ray steepness (dot)", $draft.minRayFloorDot, 0.1...0.8, "%.2f")
                    slider("Max hit distance", $draft.maxHitDistance, 1.0...8.0, "%.1f m")
                }
                Section("Wall grid") {
                    Toggle("Manual angle", isOn: $overrideOn)
                        .onChange(of: overrideOn) { _, on in
                            if on {
                                overrideDeg = (session.floor?.gridAngle ?? 0) * 180 / .pi
                                draft.gridAngleOverride = overrideDeg * .pi / 180
                            } else {
                                draft.gridAngleOverride = nil
                            }
                            commit()
                        }
                    if overrideOn {
                        HStack {
                            Text("Angle").frame(width: 120, alignment: .leading)
                            Slider(value: $overrideDeg, in: -45...45, step: 0.5) { editing in
                                if !editing {
                                    draft.gridAngleOverride = overrideDeg * .pi / 180
                                    commit()
                                }
                            }
                            Text(String(format: "%.1f°", overrideDeg)).monospacedDigit().frame(width: 56, alignment: .trailing)
                        }
                    }
                    HStack {
                        Text("Yaw votes needed").frame(width: 150, alignment: .leading)
                        Stepper("\(draft.yawMinSamples)", value: $draft.yawMinSamples, in: 10...200, step: 10)
                            .onChange(of: draft.yawMinSamples) { _, _ in commit() }
                    }
                    slider("Yaw inlier fraction", $draft.yawMinInlierFraction, 0.1...0.8, "%.2f")
                    Button("Align now from evidence") { _ = session.alignGridNow(); onPersist() }
                    Button("Re-box all rooms with these settings") { session.reboxRooms(); onPersist() }
                    Button("Reset to defaults") {
                        draft = .standard
                        overrideOn = false
                        commit()
                    }
                }
                Section("Live link to Mac") {
                    TextField("Mac IP or host (e.g. 192.168.1.20)", text: $liveHost)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    HStack {
                        Button(live.connected ? "Reconnect" : "Connect") { live.connect(host: liveHost) }
                        Spacer()
                        Button("Off") { live.disconnect() }
                    }
                    Text(live.status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Run `npm run dev` on the Mac and open /homewalk-live.html. Settings changed there apply here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Site footprint (from the Mac)") {
                    TextField("Street address, zip", text: $siteAddress)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                    Button("Load footprint") { loadFootprint() }
                        .disabled(liveHost.isEmpty || siteAddress.isEmpty)
                    if let site = session.site {
                        Text(String(format: "%.0f m² footprint, walls on %.1f° · %@", site.areaSquareMeters, site.wallBearingDegrees, site.placementNote ?? "waiting for GPS + compass"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if !siteStatus.isEmpty {
                        Text(siteStatus).font(.caption).foregroundStyle(.secondary)
                    }
                    Text("The Mac looks the footprint up in public map data and sends the outline. It is drawn on the mini-map once a GPS fix and the compass place it; rooms you close refine the fit.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Tune")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            draft = session.settings
            overrideOn = draft.gridAngleOverride != nil
            overrideDeg = (draft.gridAngleOverride ?? session.floor?.gridAngle ?? 0) * 180 / .pi
        }
    }

    private func slider(_ label: String, _ value: Binding<Double>, _ range: ClosedRange<Double>, _ fmt: String) -> some View {
        HStack {
            Text(label).frame(width: 150, alignment: .leading).font(.subheadline)
            Slider(value: value, in: range) { editing in
                if !editing { commit() }
            }
            Text(String(format: fmt, value.wrappedValue)).monospacedDigit().font(.caption).frame(width: 56, alignment: .trailing)
        }
    }

    private func commit() {
        session.updateSettings(draft)
        onPersist()
    }

    private func loadFootprint() {
        let hostPort = liveHost.contains(":") ? liveHost : "\(liveHost):8787"
        guard var comps = URLComponents(string: "http://\(hostPort)/site") else { return }
        comps.queryItems = [URLQueryItem(name: "address", value: siteAddress)]
        guard let url = comps.url else { return }
        siteStatus = "asking the Mac…"
        URLSession.shared.dataTask(with: url) { data, _, error in
            DispatchQueue.main.async {
                if let error { siteStatus = "failed: \(error.localizedDescription)"; return }
                guard let data, let site = try? JSONDecoder().decode(SiteRecord.self, from: data) else {
                    siteStatus = "no footprint returned (check the address and that npm run dev is up)"
                    return
                }
                session.setSite(site)
                onPersist()
                siteStatus = String(format: "footprint loaded: %.0f m²", site.areaSquareMeters)
            }
        }.resume()
    }
}

/// Full-size version of the mini-map: camera path, hits, box, rooms, doors.
struct DebugMapView: View {
    @ObservedObject var session: CaptureSession
    var onClose: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Canvas { context, size in
                context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(HWTheme.ink.opacity(0.94)))
                var pts = session.rooms.flatMap(\.displayPolygon) + session.inProgressDisplayPolygon + session.walkSamples + (session.footprintPlan ?? [])
                if pts.isEmpty { pts = [Vec2.zero] }
                let b = Geometry.bounds(pts) ?? (min: Vec2(x: -1, y: -1), max: Vec2(x: 1, y: 1))
                let pad = 1.0
                let widthM = max(3, b.max.x - b.min.x + pad * 2)
                let heightM = max(3, b.max.y - b.min.y + pad * 2)
                let scale = min(size.width / widthM, size.height / heightM)
                func pt(_ p: Vec2) -> CGPoint {
                    CGPoint(x: (p.x - (b.min.x - pad)) * scale, y: ((b.max.y + pad) - p.y) * scale)
                }
                // metre grid
                var grid = Path()
                var gx = floor(b.min.x - pad)
                while gx <= b.max.x + pad { grid.move(to: pt(Vec2(x: gx, y: b.min.y - pad))); grid.addLine(to: pt(Vec2(x: gx, y: b.max.y + pad))); gx += 1 }
                var gy = floor(b.min.y - pad)
                while gy <= b.max.y + pad { grid.move(to: pt(Vec2(x: b.min.x - pad, y: gy))); grid.addLine(to: pt(Vec2(x: b.max.x + pad, y: gy))); gy += 1 }
                context.stroke(grid, with: .color(HWTheme.paper.opacity(0.08)), lineWidth: 1)
                if let fp = session.footprintPlan, let first = fp.first {
                    var path = Path()
                    path.move(to: pt(first))
                    for p in fp.dropFirst() { path.addLine(to: pt(p)) }
                    path.closeSubpath()
                    context.fill(path, with: .color(Color.teal.opacity(0.12)))
                    context.stroke(path, with: .color(Color.teal), lineWidth: 2)
                }
                for room in session.rooms {
                    var path = Path()
                    guard let first = room.displayPolygon.first else { continue }
                    path.move(to: pt(first))
                    for p in room.displayPolygon.dropFirst() { path.addLine(to: pt(p)) }
                    path.closeSubpath()
                    context.fill(path, with: .color(HWTheme.blueprint.opacity(0.45)))
                    context.stroke(path, with: .color(HWTheme.paper), lineWidth: 1.5)
                    if room.walkPath.count > 1 {
                        var trail = Path()
                        trail.move(to: pt(room.walkPath[0]))
                        for p in room.walkPath.dropFirst() { trail.addLine(to: pt(p)) }
                        context.stroke(trail, with: .color(HWTheme.stamp.opacity(0.6)), lineWidth: 1)
                    }
                    if let c = Geometry.bounds(room.displayPolygon) {
                        let center = pt(Vec2(x: (c.min.x + c.max.x) / 2, y: (c.min.y + c.max.y) / 2))
                        context.draw(Text("\(room.name) \(room.sizeLabel)").font(.system(size: 10, weight: .semibold)).foregroundStyle(HWTheme.paper), at: center)
                    }
                }
                for door in session.doorways {
                    var path = Path()
                    path.move(to: pt(door.endpointA))
                    path.addLine(to: pt(door.endpointB))
                    context.stroke(path, with: .color(HWTheme.brass), lineWidth: 4)
                }
                for pose in session.walkPoses.suffix(400) {
                    if let h = pose.hit {
                        let c = pt(h)
                        context.fill(Path(ellipseIn: CGRect(x: c.x - 1.5, y: c.y - 1.5, width: 3, height: 3)), with: .color(HWTheme.moss.opacity(0.7)))
                    }
                }
                let trail = session.walkSamples
                if let first = trail.first {
                    var path = Path()
                    path.move(to: pt(first))
                    for p in trail.dropFirst() { path.addLine(to: pt(p)) }
                    context.stroke(path, with: .color(HWTheme.stamp), lineWidth: 2)
                }
                let live = session.inProgressDisplayPolygon
                if let first = live.first {
                    var path = Path()
                    path.move(to: pt(first))
                    for p in live.dropFirst() { path.addLine(to: pt(p)) }
                    path.closeSubpath()
                    context.stroke(path, with: .color(HWTheme.tape), style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                }
                if let me = session.walkPoses.last {
                    let c = pt(me.camera)
                    context.fill(Path(ellipseIn: CGRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10)), with: .color(HWTheme.paper))
                    if let yaw = me.yaw {
                        var dir = Path()
                        dir.move(to: c)
                        dir.addLine(to: CGPoint(x: c.x + cos(yaw) * 22, y: c.y - sin(yaw) * 22))
                        context.stroke(dir, with: .color(HWTheme.paper), lineWidth: 2)
                    }
                }
                let est = session.gridEstimate
                let legend = "red path · green hits · dashed box · " + (est.angleDegrees.map { String(format: "grid est %.1f°", $0) } ?? "no grid est")
                context.draw(Text(legend).font(.system(size: 10)).foregroundStyle(HWTheme.paper.opacity(0.8)), at: CGPoint(x: size.width / 2, y: size.height - 12))
            }
            Button("Close", action: onClose)
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .tint(HWTheme.tape)
                .padding(10)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(HWTheme.tape, lineWidth: 1))
        .accessibilityIdentifier("debug-map")
    }
}
