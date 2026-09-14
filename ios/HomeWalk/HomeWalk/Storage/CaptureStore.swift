import AVFoundation
import Foundation

struct SessionSummary: Identifiable, Equatable {
    var id: UUID
    var name: String
    var createdAt: Date
    var roomCount: Int
    var roomNames: [String] = []
    var directory: URL

    var summaryLine: String {
        if roomCount == 0 { return "No rooms yet" }
        let names = roomNames.prefix(3).joined(separator: ", ")
        let more = roomCount > 3 ? " +\(roomCount - 3)" : ""
        return "\(roomCount) room\(roomCount == 1 ? "" : "s") · \(names)\(more)"
    }
}

final class CaptureStore {
    let root: URL

    init(root: URL? = nil) {
        if let root {
            self.root = root
        } else {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.root = docs.appendingPathComponent("HomeWalkCaptures", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
    }

    func sessionDirectory(id: UUID) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    func save(_ session: CaptureSession) {
        let dir = sessionDirectory(id: session.document.sessionID)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let data = try? session.exportedJSON() else { return }
        let dest = dir.appendingPathComponent("plan.json")
        let tmp = dir.appendingPathComponent("plan.json.tmp")
        do {
            try data.write(to: tmp, options: .atomic)
            if FileManager.default.fileExists(atPath: dest.path) {
                _ = try FileManager.default.replaceItemAt(dest, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: dest)
            }
            let svg = session.svgString().data(using: .utf8)
            try svg?.write(to: dir.appendingPathComponent("plan.svg"), options: .atomic)
            let checklist = session.checklist.map { item in
                "[\(item.done ? "x" : " ")] \(item.category): \(item.title)"
            }.joined(separator: "\n") + "\n"
            try checklist.write(
                to: dir.appendingPathComponent("checklist.txt"),
                atomically: true,
                encoding: .utf8
            )
        } catch {
            try? data.write(to: dest, options: .atomic)
        }
    }

    func delete(id: UUID) {
        try? FileManager.default.removeItem(at: sessionDirectory(id: id))
    }

    func load(id: UUID) throws -> CaptureSession {
        let url = sessionDirectory(id: id).appendingPathComponent("plan.json")
        let data = try Data(contentsOf: url)
        return try CaptureSession.fromJSON(data)
    }

    /// Recover the playable duration of an interrupted/fragmented file. Keep
    /// the original media untouched and never invent a missing clock anchor.
    @MainActor
    func recoverInterruptedMedia(_ session: CaptureSession) async {
        guard var record = session.media else { return }
        let dir = sessionDirectory(id: session.document.sessionID)
        var recovered = false
        for isVideo in [true, false] {
            let name = isVideo ? record.videoPath : record.audioPath
            let start = isVideo ? record.videoStartedAt : record.audioStartedAt
            let end = isVideo ? record.videoEndedAt : record.audioEndedAt
            guard let name, name == URL(fileURLWithPath: name).lastPathComponent,
                  let start, end == nil else { continue }
            let url = dir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do {
                let duration = try await AVURLAsset(url: url).load(.duration).seconds
                guard duration.isFinite, duration > 0 else { continue }
                if isVideo { record.videoEndedAt = start + duration }
                else { record.audioEndedAt = start + duration }
                session.recordCaptureEvent("mediaRecovered", detail: String(format: "%@: %.2f playable seconds; original file preserved", name, duration))
                recovered = true
            } catch {
                session.setLastError("An interrupted recording could not be read. Export the capture to inspect the original files.")
                session.recordCaptureEvent("mediaRecoveryFailed", detail: name)
            }
        }
        if recovered { session.setMedia(record) }
        if session.walkRecording {
            session.stopWalkRecording()
            session.recordCaptureEvent("captureRecovered", detail: "Recovered an interrupted walk; start a new capture to record again")
        }
        save(session)
    }

    func list() -> [SessionSummary] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        return dirs.compactMap { dir -> SessionSummary? in
            let plan = dir.appendingPathComponent("plan.json")
            guard let data = try? Data(contentsOf: plan),
                  let session = try? CaptureSession.fromJSON(data)
            else { return nil }
            return SessionSummary(
                id: session.document.sessionID,
                name: session.document.name,
                createdAt: session.document.createdAt,
                roomCount: session.document.rooms.count,
                roomNames: session.document.rooms.map(\.name),
                directory: dir
            )
        }
        .sorted { $0.createdAt > $1.createdAt }
    }

    /// JSON + SVG in a folder ready for the share sheet. No network.
    func exportBundle(session: CaptureSession) throws -> URL {
        let dir = sessionDirectory(id: session.document.sessionID)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        save(session)
        let bundleName = "HomeWalk-\(sanitize(session.document.name)).homewalk"
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(bundleName, isDirectory: true)
        if FileManager.default.fileExists(atPath: out.path) {
            try FileManager.default.removeItem(at: out)
        }
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        var files = ["plan.json", "plan.svg", "manifest.json"]
        let extras = ["checklist.txt", WalkCopy.videoFilename, WalkCopy.videoPlaceholderFilename, WalkCopy.audioFilename]
        for name in extras where FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) {
            files.append(name)
        }
        let manifest: [String: Any] = [
            "schemaVersion": CaptureDocument.currentSchemaVersion,
            "appVersion": CaptureDocument.appVersion,
            "sessionID": session.document.sessionID.uuidString,
            "exportedAt": ISO8601DateFormatter().string(from: Date()),
            "files": files
        ]
        let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try manifestData.write(to: out.appendingPathComponent("manifest.json"))
        for name in files where name != "manifest.json" {
            let src = dir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: src.path) else { continue }
            try FileManager.default.copyItem(at: src, to: out.appendingPathComponent(name))
        }
        return out
    }

    private func sanitize(_ name: String) -> String {
        let trimmed = name.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        return trimmed.isEmpty ? "capture" : trimmed
    }
}

enum SVGExport {
    static func render(document: CaptureDocument) -> String {
        var pts = document.rooms.flatMap(\.displayPolygon)
        pts += document.inProgress.points.map { $0.displayPlan(snapEnabled: document.inProgress.snapEnabled) }
        pts += document.inProgress.walkSamples
        pts += document.doorways.flatMap { [$0.endpointA, $0.endpointB] }
        let scale: Double = 40
        let pad: Double = 1.0
        let b = Geometry.bounds(pts) ?? (min: Vec2(x: -1, y: -1), max: Vec2(x: 1, y: 1))
        let minX = b.min.x - pad
        let maxY = b.max.y + pad
        let widthM = max(2.0, b.max.x - b.min.x + pad * 2)
        let heightM = max(2.0, b.max.y - b.min.y + pad * 2)
        func sx(_ p: Vec2) -> String { String(format: "%.2f", (p.x - minX) * scale) }
        func sy(_ p: Vec2) -> String { String(format: "%.2f", (maxY - p.y) * scale) }

        var body = ""
        let palette = ["#1f4e79", "#b45309", "#166534", "#7c3aed", "#9f1239"]
        for (i, room) in document.rooms.enumerated() {
            let color = palette[i % palette.count]
            let d = room.displayPolygon.map { "\(sx($0)),\(sy($0))" }.joined(separator: " ")
            body += "<polygon points=\"\(d)\" fill=\"\(color)\" fill-opacity=\"0.18\" stroke=\"\(color)\" stroke-width=\"2\"/>\n"
            if let c = centroid(room.displayPolygon) {
                body += "<text x=\"\(sx(c))\" y=\"\(sy(c))\" font-size=\"11\" text-anchor=\"middle\" fill=\"#111\">\(escape(room.name))</text>\n"
            }
        }
        for door in document.doorways {
            body += "<line x1=\"\(sx(door.endpointA))\" y1=\"\(sy(door.endpointA))\" x2=\"\(sx(door.endpointB))\" y2=\"\(sy(door.endpointB))\" stroke=\"#111\" stroke-width=\"6\" stroke-linecap=\"butt\"/>\n"
            body += "<line x1=\"\(sx(door.endpointA))\" y1=\"\(sy(door.endpointA))\" x2=\"\(sx(door.endpointB))\" y2=\"\(sy(door.endpointB))\" stroke=\"#f4efe4\" stroke-width=\"3\" stroke-linecap=\"butt\"/>\n"
        }
        if document.inProgress.points.count >= 1 {
            let open = document.inProgress.points.map { $0.displayPlan(snapEnabled: document.inProgress.snapEnabled) }
            let d = open.map { "\(sx($0)),\(sy($0))" }.joined(separator: " ")
            body += "<polyline points=\"\(d)\" fill=\"none\" stroke=\"#c9a227\" stroke-width=\"2\"/>\n"
        }
        if document.inProgress.walkSamples.count >= 2 {
            let d = document.inProgress.walkSamples.map { "\(sx($0)),\(sy($0))" }.joined(separator: " ")
            body += "<polyline points=\"\(d)\" fill=\"none\" stroke=\"#b42323\" stroke-width=\"1.5\" stroke-dasharray=\"4 3\"/>\n"
        }
        let svgW = widthM * scale
        let svgH = heightM * scale
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \(String(format: "%.1f", svgW)) \(String(format: "%.1f", svgH))" width="\(String(format: "%.0f", svgW))" height="\(String(format: "%.0f", svgH))">
        <rect width="100%" height="100%" fill="#f4efe4"/>
        \(body)
        </svg>
        """
    }

    private static func centroid(_ pts: [Vec2]) -> Vec2? {
        guard !pts.isEmpty else { return nil }
        let s = pts.reduce(Vec2.zero, +)
        return Vec2(x: s.x / Double(pts.count), y: s.y / Double(pts.count))
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
