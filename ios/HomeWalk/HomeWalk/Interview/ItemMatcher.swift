import Foundation

/// Something the walker named out loud, recognised on-device from the
/// transcript. Instant feedback while walking; the post-walk model verifies
/// it against the video later.
struct CapturedItem: Codable, Equatable, Identifiable {
    var id: UUID
    var label: String
    var category: String
    var roomID: UUID?
    var timestamp: TimeInterval
    var transcript: String
    /// Checklist prompt this satisfied, if any.
    var promptTitle: String?
}

struct TranscriptSegment: Codable, Equatable, Identifiable {
    var id: UUID
    var startedAt: TimeInterval
    var endedAt: TimeInterval
    var text: String
    var roomID: UUID?
}

/// A prompt the walk asks for. `keywords` are what we listen for; any hit
/// marks the prompt done and captures the item.
struct WalkPrompt: Equatable {
    var title: String
    var ask: String
    var category: String
    var keywords: [String]
}

/// Keyword → item recogniser. Deliberately simple and fast: phrases are
/// matched longest-first against the lower-cased transcript, so "water heater"
/// wins over "water". Good enough for instant on-screen feedback; not a
/// substitute for the model reading the tape afterwards.
enum ItemMatcher {
    struct Hit: Equatable {
        var label: String
        var category: String
        var phrase: String
    }

    /// phrase → (label, category)
    static let vocabulary: [(phrase: String, label: String, category: String)] = [
        ("electrical panel", "electrical panel", "control"), ("breaker panel", "electrical panel", "control"), ("breaker box", "electrical panel", "control"),
        ("fuse box", "electrical panel", "control"), ("breakers", "electrical panel", "control"), ("panel", "electrical panel", "control"),
        ("water heater", "water heater", "appliance"), ("hot water heater", "water heater", "appliance"), ("hot water tank", "water heater", "appliance"),
        ("furnace", "furnace", "appliance"), ("air conditioner", "air conditioner", "appliance"), ("ac unit", "air conditioner", "appliance"),
        ("a/c", "air conditioner", "appliance"), ("hvac", "HVAC", "appliance"), ("heat pump", "heat pump", "appliance"), ("thermostat", "thermostat", "control"),
        ("water shutoff", "water shutoff", "control"), ("water shut off", "water shutoff", "control"), ("shutoff valve", "water shutoff", "control"),
        ("shut off valve", "water shutoff", "control"), ("main valve", "water shutoff", "control"), ("water main", "water shutoff", "control"),
        ("gas shutoff", "gas shutoff", "control"), ("gas shut off", "gas shutoff", "control"), ("gas meter", "gas meter", "control"),
        ("smoke detector", "smoke detector", "safety"), ("smoke alarm", "smoke detector", "safety"), ("carbon monoxide", "CO detector", "safety"),
        ("fire extinguisher", "fire extinguisher", "safety"), ("baby gate", "baby gate", "safety"),
        ("refrigerator", "refrigerator", "appliance"), ("fridge", "refrigerator", "appliance"), ("freezer", "freezer", "appliance"),
        ("dishwasher", "dishwasher", "appliance"), ("oven", "oven", "appliance"), ("stove", "range", "appliance"), ("range", "range", "appliance"),
        ("cooktop", "cooktop", "appliance"), ("microwave", "microwave", "appliance"), ("garbage disposal", "garbage disposal", "appliance"),
        ("disposal", "garbage disposal", "appliance"), ("washer", "washing machine", "appliance"), ("washing machine", "washing machine", "appliance"),
        ("dryer", "dryer", "appliance"), ("wine fridge", "wine fridge", "appliance"), ("ice maker", "ice maker", "appliance"),
        ("air filter", "air filter", "maintenance"), ("furnace filter", "air filter", "maintenance"), ("filter", "filter", "maintenance"),
        ("sprinkler", "sprinkler controller", "control"), ("irrigation", "sprinkler controller", "control"), ("pool pump", "pool pump", "appliance"),
        ("pool heater", "pool heater", "appliance"), ("sump pump", "sump pump", "appliance"), ("water softener", "water softener", "appliance"),
        ("garage door opener", "garage door opener", "control"), ("garage door", "garage door", "fixture"),
        ("television", "TV", "valuable"), ("tv", "TV", "valuable"), ("sound bar", "sound bar", "valuable"), ("speaker", "speaker", "valuable"),
        ("computer", "computer", "valuable"), ("laptop", "laptop", "valuable"), ("piano", "piano", "valuable"), ("artwork", "artwork", "valuable"),
        ("jewelry", "jewelry", "valuable"), ("safe", "safe", "valuable"), ("bike", "bicycle", "valuable"), ("bicycle", "bicycle", "valuable"),
        ("serial number", "serial number", "detail"), ("model number", "model number", "detail"),
        ("sink", "sink", "fixture"), ("toilet", "toilet", "fixture"), ("shower", "shower", "fixture"), ("bathtub", "bathtub", "fixture"), ("tub", "bathtub", "fixture"),
        ("fireplace", "fireplace", "fixture"), ("ceiling fan", "ceiling fan", "fixture"), ("skylight", "skylight", "fixture"),
        ("sliding door", "sliding door", "opening"), ("patio door", "patio door", "opening"), ("french doors", "french doors", "opening"),
        ("front door", "front door", "opening"), ("back door", "back door", "opening"), ("window", "window", "opening"), ("closet", "closet", "storage"), ("pantry", "pantry", "storage"),
        ("sofa", "sofa", "furniture"), ("couch", "sofa", "furniture"), ("sectional", "sectional sofa", "furniture"), ("dining table", "dining table", "furniture"),
        ("island", "kitchen island", "furniture"), ("bed", "bed", "furniture"), ("desk", "desk", "furniture"),
    ]

    private static let sorted = vocabulary.sorted { $0.phrase.count > $1.phrase.count }

    static func normalize(_ text: String) -> String {
        let lowered = text.lowercased()
        let cleaned = lowered.map { $0.isLetter || $0.isNumber || $0 == " " || $0 == "/" ? $0 : Character(" ") }
        return " " + String(cleaned).split(separator: " ").joined(separator: " ") + " "
    }

    /// All distinct items mentioned in `text`, longest phrase first.
    static func match(_ text: String) -> [Hit] {
        var s = normalize(text)
        var hits: [Hit] = []
        for entry in sorted {
            let needle = " \(entry.phrase) "
            guard s.contains(needle) else { continue }
            if !hits.contains(where: { $0.label == entry.label }) {
                hits.append(Hit(label: entry.label, category: entry.category, phrase: entry.phrase))
            }
            // Blank out so shorter phrases inside it ("water") don't re-match.
            s = s.replacingOccurrences(of: needle, with: " ")
        }
        return hits
    }

    /// Which prompts does this transcript satisfy? Longest keyword wins and is
    /// blanked out, so "furnace filter" is the filter prompt, not the heating one.
    static func prompts(satisfiedBy text: String, in prompts: [WalkPrompt]) -> [WalkPrompt] {
        var s = normalize(text)
        let pairs = prompts.flatMap { p in p.keywords.map { (keyword: $0, prompt: p) } }
            .sorted { $0.keyword.count > $1.keyword.count }
        var out: [WalkPrompt] = []
        for pair in pairs {
            let needle = " \(pair.keyword) "
            guard s.contains(needle) else { continue }
            if !out.contains(pair.prompt) { out.append(pair.prompt) }
            s = s.replacingOccurrences(of: needle, with: " ")
        }
        return out
    }
}
