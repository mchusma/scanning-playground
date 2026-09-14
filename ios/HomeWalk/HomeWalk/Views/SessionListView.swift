import AVFoundation
import Speech
import SwiftUI

struct SessionListView: View {
    @EnvironmentObject var app: AppModel
    @State private var showBuildNotes = false
    @AppStorage("homewalk.debug") private var debugEnabled = false

    var body: some View {
        NavigationStack {
            ZStack {
                HWTheme.paper.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    Text("HomeWalk")
                        .font(.system(.largeTitle, design: .serif).weight(.regular))
                        .foregroundStyle(HWTheme.navy)
                    Text("Walk the house once. Get a measured floor plan, an insurance inventory, and a guidebook — recorded as you go.")
                        .font(.body)
                        .foregroundStyle(HWTheme.ink.opacity(0.8))
                    LargeActionButton(
                        title: "Start a walkthrough",
                        identifier: "start-capture",
                        fill: HWTheme.brass,
                        action: { app.startNewCapture() }
                    )
                    Button("How a walkthrough works") {
                        app.reopenOnboarding()
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HWTheme.navy)
                    .accessibilityIdentifier("reopen-onboarding")
                    if app.sessions.isEmpty {
                        Text("No saved walkthroughs yet.")
                            .foregroundStyle(HWTheme.ink.opacity(0.6))
                            .padding(.top, 12)
                    } else {
                        List {
                            ForEach(app.sessions) { item in
                                Button {
                                    app.open(item)
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item.name)
                                            .font(.headline)
                                            .foregroundStyle(HWTheme.ink)
                                        Text(item.summaryLine)
                                            .font(.subheadline)
                                            .foregroundStyle(HWTheme.ink.opacity(0.6))
                                    }
                                }
                                .listRowBackground(HWTheme.paper)
                            }
                            .onDelete { offsets in
                                for i in offsets { app.delete(app.sessions[i]) }
                            }
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                    }
                    Spacer()
                    DisclosureGroup(isExpanded: $showBuildNotes) {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(WalkCopy.buildNotes, id: \.self) { note in
                                Text("• \(note)")
                            }
                            Toggle("Debug HUD on the walk screen", isOn: $debugEnabled)
                                .font(.caption.weight(.semibold))
                                .tint(HWTheme.navy)
                                .padding(.top, 6)
                                .accessibilityIdentifier("debug-toggle")
                        }
                        .font(.caption)
                        .foregroundStyle(HWTheme.ink.opacity(0.6))
                        .padding(.top, 4)
                    } label: {
                        Text("About this build")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HWTheme.ink.opacity(0.5))
                    }
                    .tint(HWTheme.ink.opacity(0.5))
                    .accessibilityIdentifier("build-notes")
                }
                .padding(20)
            }
        }
    }
}

/// Explains, then actually requests, camera and microphone access before the
/// AR view appears — so the system dialogs never pop over a black camera.
struct PermissionsView: View {
    @EnvironmentObject var app: AppModel
    let caps = SpatialCapabilities.current()
    @State private var camera: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var mic: AVAudioApplication.recordPermission = AVAudioApplication.shared.recordPermission
    @StateObject private var geo = GeoProvider()
    @State private var speechStatus: SFSpeechRecognizerAuthorizationStatus = SFSpeechRecognizer.authorizationStatus()

    private var cameraGranted: Bool { camera == .authorized }
    private var micGranted: Bool { mic == .granted }
    private var canStart: Bool { (cameraGranted && micGranted) || !caps.worldTrackingSupported }

    var body: some View {
        ZStack {
            HWTheme.paper.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Before we walk")
                        .font(.system(.title, design: .serif))
                    Text("Camera and microphone are needed; location is optional but lets the plan face north and sit on your lot.")
                        .font(.subheadline)
                        .foregroundStyle(HWTheme.ink.opacity(0.7))
                }

                permissionRow(
                    icon: "camera.fill",
                    title: "Camera",
                    body: "Sees the floor to measure where you walk.",
                    granted: cameraGranted,
                    denied: camera == .denied || camera == .restricted,
                    identifier: "permission-camera"
                ) { requestCamera() }

                permissionRow(
                    icon: "mic.fill",
                    title: "Microphone",
                    body: "Records what you say so it can be pinned to each room.",
                    granted: micGranted,
                    denied: mic == .denied,
                    identifier: "permission-mic"
                ) { requestMic() }
                .accessibilityIdentifier("mic-explanation")

                permissionRow(
                    icon: "waveform.and.mic",
                    title: "Speech recognition (optional)",
                    body: "Hears what you name so prompts tick themselves. On-device when your phone supports it.",
                    granted: speechStatus == .authorized,
                    denied: speechStatus == .denied || speechStatus == .restricted,
                    identifier: "permission-speech"
                ) { Task { speechStatus = await SpeechCapture.requestSpeechAuthorization() } }

                permissionRow(
                    icon: "location.fill",
                    title: "Location (optional)",
                    body: "Points the plan north with the compass and places it on the building outline.",
                    granted: geo.authorized,
                    denied: geo.authorization == .denied || geo.authorization == .restricted,
                    identifier: "permission-location"
                ) { geo.request() }

                if !caps.worldTrackingSupported {
                    Text("Simulator: no camera tracking here. A meter grid stands in; drag it to walk.")
                        .font(.footnote)
                        .foregroundStyle(HWTheme.ink.opacity(0.6))
                }

                if (camera == .denied || mic == .denied), let url = URL(string: UIApplication.openSettingsURLString) {
                    Link("Open Settings to allow access", destination: url)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HWTheme.stamp)
                }

                Spacer()
                LargeActionButton(
                    title: canStart ? "Find your property" : "Allow access to continue",
                    identifier: "begin-capture",
                    fill: HWTheme.brass,
                    enabled: canStart
                ) {
                    app.route = .property
                }
            }
            .foregroundStyle(HWTheme.ink)
            .padding(20)
        }
        .onAppear {
            // Ask straight away; the rows show the result and offer a retry.
            if camera == .notDetermined { requestCamera() }
        }
    }

    private func permissionRow(
        icon: String,
        title: String,
        body: String,
        granted: Bool,
        denied: Bool,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(HWTheme.navy)
                .frame(width: 36, height: 36)
                .background(HWTheme.navy.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(body).font(.subheadline).foregroundStyle(HWTheme.ink.opacity(0.7))
            }
            Spacer()
            if granted {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(HWTheme.moss)
                    .font(.title3)
            } else if denied {
                Text("Denied")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HWTheme.stamp)
            } else {
                Button("Allow", action: action)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HWTheme.navy)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("\(identifier)-allow")
            }
        }
        .accessibilityIdentifier(identifier)
    }

    private func requestCamera() {
        AVCaptureDevice.requestAccess(for: .video) { _ in
            DispatchQueue.main.async {
                camera = AVCaptureDevice.authorizationStatus(for: .video)
                if mic == .undetermined { requestMic() }
            }
        }
    }

    private func requestMic() {
        AVAudioApplication.requestRecordPermission { _ in
            DispatchQueue.main.async {
                mic = AVAudioApplication.shared.recordPermission
            }
        }
    }
}
