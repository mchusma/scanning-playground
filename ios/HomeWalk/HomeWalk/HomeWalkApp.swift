import SwiftUI

@main
struct HomeWalkApp: App {
    @StateObject private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        switch app.route {
        case .onboarding:
            OnboardingView()
        case .list:
            SessionListView()
                .alert("Replay could not open", isPresented: Binding(get: { app.replayLoadError != nil }, set: { if !$0 { app.replayLoadError = nil } })) {
                    Button("OK") { app.replayLoadError = nil }
                } message: { Text(app.replayLoadError ?? "") }
        case .permissions:
            PermissionsView()
        case .property:
            PropertyView()
        case .capture:
            if let session = app.current {
                WalkCaptureView(session: session, replay: app.replay)
            } else {
                SessionListView()
            }
        case .review:
            if let session = app.current {
                ReviewView(session: session)
            } else {
                SessionListView()
            }
        }
    }
}
