import SwiftUI
import WebKit

/// The local Mac owns revision history and model calls. This shared editor uses
/// the same deterministic wall operations for direct manipulation and chat.
struct PlanAssistantView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var session: CaptureSession
    @AppStorage("homewalk.liveHost") private var host = ""
    @State private var serverURL: URL?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let error { Text(error).font(.footnote).foregroundStyle(HWTheme.stamp).padding(12) }
                if let serverURL {
                    PlanAssistantWebView(session: session, baseURL: serverURL,
                                         mediaDirectory: app.store.sessionDirectory(id: session.document.sessionID),
                                         replayDirectory: app.replay?.directory,
                                         onError: { error = $0 }, onSave: { app.persist() })
                } else {
                    Form {
                        Text("Open the HomeWalk server on your Mac. Plan revisions and the conversation are saved there.")
                        TextField("Mac address: e.g. 192.168.1.10:8787", text: $host)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("assistant-host")
                        Button("Open plan editor") { connect() }.accessibilityIdentifier("assistant-connect")
                    }
                }
            }
            .navigationTitle("Refine your plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Connection") { serverURL = nil } }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .onAppear {
                #if targetEnvironment(simulator)
                if host.isEmpty || app.uiTesting { host = "localhost:8787" }
                #endif
                if !host.isEmpty { connect() }
            }
        }
    }

    private func connect() {
        let raw = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var c = URLComponents(string: raw.contains("://") ? raw : "http://\(raw)"),
              c.host != nil, ["http", "https"].contains(c.scheme ?? "") else {
            error = "Enter the HomeWalk server address shown on your Mac."; return
        }
        if c.port == nil, c.scheme == "http" { c.port = 8787 }
        c.path = "/"; c.query = nil; c.fragment = nil
        serverURL = c.url; error = nil
    }
}

private struct PlanAssistantWebView: UIViewRepresentable {
    var session: CaptureSession
    var baseURL: URL
    var mediaDirectory: URL
    var replayDirectory: URL?
    var onError: (String) -> Void
    var onSave: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "homewalk")
        config.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        context.coordinator.web = web
        web.load(URLRequest(url: baseURL.appendingPathComponent("homewalk-adjust.html")))
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {}
    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "homewalk")
    }

    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let parent: PlanAssistantWebView
        weak var web: WKWebView?
        init(_ parent: PlanAssistantWebView) { self.parent = parent }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == parent.baseURL.host,
                  message.frameInfo.securityOrigin.protocol == parent.baseURL.scheme,
                  message.frameInfo.securityOrigin.port == (parent.baseURL.port ?? (parent.baseURL.scheme == "https" ? 443 : 80)),
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            if type == "ready" {
                do {
                    let object = try JSONSerialization.jsonObject(with: parent.session.exportedJSON())
                    web?.callAsyncJavaScript("await window.homewalkInit(payload)", arguments: ["payload": ["plan": object]], in: nil, in: .page) { _ in }
                } catch { parent.onError(error.localizedDescription) }
            } else if type == "planChanged", let plan = body["plan"] as? [String: Any], let revision = body["revision"] as? Int {
                do {
                    let data = try JSONSerialization.data(withJSONObject: plan)
                    let reviewed = try CaptureSession.fromJSON(data).document
                    try parent.session.applyReviewedPlan(reviewed, revision: revision, kind: body["kind"] as? String ?? "correction")
                    parent.onSave()
                } catch { parent.onError("Could not save this revision: \(error.localizedDescription)") }
            } else if type == "uploadWalk", let projectID = body["projectID"] as? String,
                      projectID.uppercased() == parent.session.document.sessionID.uuidString {
                Task { await uploadWalk(projectID: projectID) }
            }
        }

        private func uploadWalk(projectID: String) async {
            do {
                let directory = parent.replayDirectory ?? parent.mediaDirectory
                let proxy = directory.appendingPathComponent("replay.mp4")
                let files: [(URL, String)]
                if FileManager.default.fileExists(atPath: proxy.path) {
                    files = [(proxy, "video/mp4")]
                } else {
                    files = [(directory.appendingPathComponent(parent.session.media?.videoPath ?? "walk-video.mov"), "video/quicktime"),
                             (directory.appendingPathComponent(parent.session.media?.audioPath ?? "walk-audio.m4a"), "audio/mp4")]
                        .filter { FileManager.default.fileExists(atPath: $0.0.path) }
                }
                guard !files.isEmpty else { throw NSError(domain: "PlanAssistant", code: 1, userInfo: [NSLocalizedDescriptionKey: "No recording was found. Add photos or video to the conversation instead."]) }
                var state: Any?
                for (file, mime) in files {
                    var url = URLComponents(url: parent.baseURL.appendingPathComponent("api/homewalk/plans/\(projectID)/evidence"), resolvingAgainstBaseURL: false)!
                    url.queryItems = [URLQueryItem(name: "name", value: file.lastPathComponent), URLQueryItem(name: "note", value: "Original walk recording")]
                    var request = URLRequest(url: url.url!)
                    request.httpMethod = "POST"; request.timeoutInterval = 180
                    request.setValue(mime, forHTTPHeaderField: "Content-Type")
                    let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
                    let object = try JSONSerialization.jsonObject(with: data)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                        throw NSError(domain: "PlanAssistant", code: 2, userInfo: [NSLocalizedDescriptionKey: (object as? [String: Any])?["error"] as? String ?? "Upload failed."])
                    }
                    state = object
                }
                if let state { web?.callAsyncJavaScript("window.homewalkMediaReady(payload)", arguments: ["payload": state], in: nil, in: .page) { _ in } }
            } catch {
                web?.callAsyncJavaScript("window.homewalkMediaReady(payload)", arguments: ["payload": ["error": error.localizedDescription]], in: nil, in: .page) { _ in }
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            decisionHandler(url.host == parent.baseURL.host && url.port == parent.baseURL.port && url.scheme == parent.baseURL.scheme ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.onError("Could not reach the HomeWalk server. Start npm run dev on the Mac and check the saved server address.")
        }
    }
}
