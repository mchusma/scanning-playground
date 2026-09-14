import Combine
import Foundation
import SwiftUI

enum AppRoute: Equatable {
    case onboarding
    case list
    case permissions
    case property
    case capture
    case review
}

@MainActor
final class AppModel: ObservableObject {
    @Published var replay: CaptureReplay?
    @Published var replayLoadError: String?
    @Published var sessions: [SessionSummary] = []
    @Published var current: CaptureSession?
    @Published var route: AppRoute = .onboarding
    @Published var lastExportURL: URL?
    @Published var micExplainerNeeded = true
    @Published var onboardingDone: Bool

    let store: CaptureStore
    let uiTesting: Bool
    /// UI tests pass `--hear "<sentence>"` to stand in for speech once a walk starts.
    let uiTestHeardPhrase: String?

    init(store: CaptureStore = CaptureStore(), uiTesting: Bool = ProcessInfo.processInfo.arguments.contains("--uitesting")) {
        self.store = store
        self.uiTesting = uiTesting
        let args = ProcessInfo.processInfo.arguments
        if uiTesting, let i = args.firstIndex(of: "--hear"), i + 1 < args.count { uiTestHeardPhrase = args[i + 1] } else { uiTestHeardPhrase = nil }
        self.onboardingDone = UserDefaults.standard.bool(forKey: "homewalk.onboarding.done")
        let runningTests = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            && !uiTesting
        if runningTests { return }
        sessions = store.list()
        #if targetEnvironment(simulator)
        if let i = args.firstIndex(of: "--review-capture"), i + 1 < args.count,
           let id = UUID(uuidString: args[i + 1]), let saved = try? store.load(id: id) {
            current = saved
            onboardingDone = true
            route = .review
            return
        }
        if let index = args.firstIndex(of: "--replay") {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let directory = index + 1 < args.count && !args[index + 1].hasPrefix("--")
                ? URL(fileURLWithPath: args[index + 1], isDirectory: true)
                : docs.appendingPathComponent("ReplayFixture", isDirectory: true)
            do {
                let replay = try CaptureReplay(directory: directory)
                self.replay = replay
                current = replay.session
                onboardingDone = true
                route = .property
                if args.contains("--replay-validate") {
                    replay.timeline.advance(to: replay.fixture.duration)
                    try replay.finish(store: store)
                    route = .review
                }
                return
            } catch {
                replayLoadError = error.localizedDescription
                route = .list
                return
            }
        }
        #endif
        if uiTesting {
            onboardingDone = true
            startNewCapture(skipPermissions: true)
        } else if onboardingDone {
            route = .list
        } else {
            route = .onboarding
        }
    }

    func finishOnboarding() {
        let first = !onboardingDone
        onboardingDone = true
        UserDefaults.standard.set(true, forKey: "homewalk.onboarding.done")
        if first {
            startNewCapture(skipPermissions: false)
        } else {
            route = .list
        }
    }

    func reopenOnboarding() {
        route = .onboarding
    }

    func startNewCapture(skipPermissions: Bool = false) {
        replay?.pause()
        replay = nil
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        let name = "Walkthrough \(formatter.string(from: Date()))"
        let caps = SpatialCapabilities.current()
        let session = CaptureSession(name: name, capabilities: caps)
        if !caps.worldTrackingSupported {
            session.updateTracking(.normal)
        }
        current = session
        // Not persisted yet: an abandoned start should not litter the list.
        // The first walk action persists it.
        route = skipPermissions ? .property : .permissions
    }

    func delete(_ summary: SessionSummary) {
        store.delete(id: summary.id)
        if current?.document.sessionID == summary.id { current = nil }
        sessions = store.list()
    }

    func open(_ summary: SessionSummary) {
        current = try? store.load(id: summary.id)
        if let session = current {
            route = .review
            Task { await store.recoverInterruptedMedia(session) }
        }
    }

    func persist() {
        guard let current else { return }
        store.save(current)
        sessions = store.list()
    }

    func exportCurrent() throws -> URL {
        guard let current else { throw NSError(domain: "HomeWalk", code: 1) }
        persist()
        let url = try store.exportBundle(session: current)
        lastExportURL = url
        return url
    }

    func closeToList() {
        replay?.pause()
        replay = nil
        if let current, !current.rooms.isEmpty || current.floor != nil {
            persist()
        }
        current = nil
        route = .list
        sessions = store.list()
    }
}
