import SwiftUI

/// Confirm the property before any camera recording starts. The local Mac
/// supplies cached map/listing evidence; a confirmed snapshot travels with
/// the capture so post-processing does not depend on a later lookup.
struct PropertyView: View {
    @EnvironmentObject var app: AppModel
    @AppStorage("homewalk.address") private var address = ""
    @AppStorage("homewalk.liveHost") private var host = ""
    @State private var site: SiteRecord?
    @State private var loading = false
    @State private var error: String?
    @State private var requestID = UUID()
    @State private var baseURL: URL?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Start with your home")
                        .font(.largeTitle.weight(.bold))
                    Text("Enter the address, check the outline, then walk and talk. Your recording will be assembled into a plan afterwards.")
                        .font(.body)
                    if let replay = app.replay {
                        Text("RECORDED WALK REPLAY · \(replay.fixture.poses.count) ARKit poses")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HWTheme.moss)
                        Text(replay.fixture.timingNote).font(.footnote)
                        Text("Confirm the cached property, then Start walk to play your recording through the current capture flow.")
                            .font(.footnote)
                    } else {
                    TextField("Street address, city, state and ZIP", text: $address)
                        .textContentType(.fullStreetAddress)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("property-address")
                    DisclosureGroup("Connect to your Mac") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Keep the phone and Mac on the same Wi-Fi. Enter the address shown by the HomeWalk server on your Mac.")
                                .font(.footnote)
                            TextField("Mac address, e.g. 192.168.1.10:8787", text: $host)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("property-host")
                        }
                        .padding(.top, 8)
                    }
                    LargeActionButton(
                        title: loading ? "Finding your home…" : "Find property",
                        identifier: "load-property", fill: HWTheme.brass,
                        enabled: !loading && !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) { Task { await loadProperty() } }
                    }
                    if loading { ProgressView().frame(maxWidth: .infinity) }
                    if let error {
                        Text(error).foregroundStyle(HWTheme.stamp)
                            .accessibilityIdentifier("property-error")
                    }
                    if let site {
                        preview(site)
                        LargeActionButton(
                            title: "Yes, this is my house",
                            identifier: "confirm-property", fill: HWTheme.moss, textColor: HWTheme.paper
                        ) {
                            guard let session = app.current else { return }
                            session.setSite(site)
                            app.persist()
                            app.route = .capture
                        }
                    }
                }
                .padding(20)
            }
            .background(HWTheme.paper)
            .foregroundStyle(HWTheme.ink)
            .navigationTitle("Your property")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { requestID = UUID(); app.closeToList() }
                }
            }
        }
        .onChange(of: address) { _, _ in invalidate() }
        .onChange(of: host) { _, _ in invalidate() }
        .onDisappear { requestID = UUID() }
        .onAppear {
            if let replay = app.replay {
                site = replay.fixture.site
            } else if app.uiTesting { address = "Sample home" }
        }
    }

    private func preview(_ site: SiteRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(site.address ?? address).font(.headline)
            if let replay = app.replay, let path = site.aerialPath,
               let image = UIImage(contentsOfFile: replay.directory.appendingPathComponent(path).path) {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if let path = site.aerialPath, let baseURL, let url = URL(string: path, relativeTo: baseURL) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else if phase.error != nil {
                        Text("Aerial unavailable. Check the building outline below.")
                    } else {
                        ProgressView().frame(height: 180)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            footprint(site)
                .frame(height: 170)
                .accessibilityLabel("Building footprint, north up")
            Text(String(format: "Footprint: %.0f sq ft · %.1f m²", site.areaSquareMeters * 10.7639, site.areaSquareMeters))
            if let width = site.widthEastWestMeters, let depth = site.depthNorthSouthMeters {
                Text(String(format: "Extent: %.1f m east–west × %.1f m north–south", width, depth))
                    .font(.footnote)
            }
            Text(site.source).font(.caption).foregroundStyle(.secondary)
            if let facts = site.propertyFacts {
                Text("Listing facts — please verify").font(.headline)
                Text("Beds: \(number(facts.bedrooms)) · Baths: \(number(facts.bathrooms))")
                Text("Living area: \(number(facts.livingAreaSqFt)) sq ft · Storeys: \(number(facts.storeys))")
                if !facts.roomsMentioned.isEmpty {
                    Text("Rooms mentioned: " + facts.roomsMentioned.joined(separator: ", "))
                } else {
                    Text("No listing room list is available yet.")
                }
            }
            Text("Is this your house? Confirm the outline before starting. Footprint area includes spaces that may not count as living area.")
                .font(.footnote)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("property-preview")
    }

    private func footprint(_ site: SiteRecord) -> some View {
        Canvas { context, size in
            guard let bounds = Geometry.bounds(site.footprintEastNorth) else { return }
            let scale = min((size.width - 24) / max(1, bounds.max.x - bounds.min.x),
                            (size.height - 24) / max(1, bounds.max.y - bounds.min.y))
            let center = (bounds.min + bounds.max) * 0.5
            let points = site.footprintEastNorth.map {
                CGPoint(x: size.width / 2 + ($0.x - center.x) * scale,
                        y: size.height / 2 - ($0.y - center.y) * scale)
            }
            var path = Path()
            path.addLines(points)
            path.closeSubpath()
            context.fill(path, with: .color(HWTheme.moss.opacity(0.15)))
            context.stroke(path, with: .color(HWTheme.moss), lineWidth: 2)
        }
    }

    private func number(_ value: Double?) -> String {
        value.map { String(format: "%g", $0) } ?? "unknown"
    }

    private func invalidate() {
        requestID = UUID()
        site = nil
        error = nil
        loading = false
    }

    @MainActor
    private func loadProperty() async {
        invalidate()
        let id = requestID
        loading = true
        defer { if requestID == id { loading = false } }
        do {
            if app.uiTesting {
                site = SiteRecord(
                    footprintEastNorth: [.init(x: -8, y: -5), .init(x: 8, y: -5), .init(x: 8, y: 5), .init(x: -8, y: 5)],
                    centroidLatitude: 0, centroidLongitude: 0, wallBearingDegrees: 0,
                    areaSquareMeters: 160, source: "Simulator fixture", address: "Sample home",
                    propertyFacts: PropertyFacts(bedrooms: 3, bathrooms: 2, livingAreaSqFt: 1500, storeys: 1, roomsMentioned: ["Kitchen", "Living room"])
                )
                return
            }
            let raw = host.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty, var components = URLComponents(string: raw.contains("://") ? raw : "http://\(raw)"),
                  let hostname = components.host, !hostname.isEmpty,
                  ["http", "https"].contains(components.scheme ?? "") else {
                throw PropertyError.message("Open Connect to your Mac and enter the HomeWalk server address.")
            }
            if components.port == nil, components.scheme == "http" { components.port = 8787 }
            components.path = "/site"
            components.queryItems = [URLQueryItem(name: "address", value: address.trimmingCharacters(in: .whitespacesAndNewlines))]
            guard let url = components.url else { throw PropertyError.message("Check the Mac address and try again.") }
            var request = URLRequest(url: url)
            request.timeoutInterval = 130
            let (data, response) = try await URLSession.shared.data(for: request)
            guard requestID == id else { return }
            guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                let problem = try? JSONDecoder().decode(ServerError.self, from: data)
                throw PropertyError.message(problem?.error ?? "Property lookup failed. Check the address and try again.")
            }
            let found = try JSONDecoder().decode(SiteRecord.self, from: data)
            guard found.footprintEastNorth.count >= 3, found.areaSquareMeters > 0 else {
                throw PropertyError.message("No usable building outline was found. Check the address and try again.")
            }
            baseURL = url
            site = found
        } catch {
            if requestID == id { self.error = error.localizedDescription }
        }
    }

    private struct ServerError: Decodable { let error: String }
    private enum PropertyError: LocalizedError {
        case message(String)
        var errorDescription: String? { switch self { case .message(let text): return text } }
    }
}
