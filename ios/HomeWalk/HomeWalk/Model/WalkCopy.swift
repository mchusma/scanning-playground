import Foundation

/// Sales, script, and in-walk copy. Onboarding and capture share this so the
/// pitch and the live walk say the same thing. Customer-facing: no build notes.
enum WalkCopy {
    static let brand = "HOMEWALK"
    static let certifiedKicker = "Home onboarding"
    static let walkPrompt = "Hold the phone at chest height and walk close to the walls. Say which room you enter and what you show. Keep walking; we assemble the plan afterwards."
    static let floorPrompt = "Point the phone at the floor a few steps ahead. Start when the floor is found."

    static let pages: [OnboardingPage] = [
        OnboardingPage(
            id: 0,
            kicker: "One walk, done right",
            title: "Walk your home once. Get a plan you can stand behind.",
            body: "Room by room, you walk and talk. You end up with a measured floor plan, an inventory for insurance, and a guidebook for anyone who stays here — assembled after the walk from your recording.",
            illustration: .plan
        ),
        OnboardingPage(
            id: 1,
            kicker: "How to hold it",
            title: "Chest height, tilted down, along the walls.",
            body: "Keep the phone steady at chest height and walk the edge of the room, close to each wall, all the way round. We measure where you go — pointing at things doesn't change the plan. Say the room name as you enter it. Keep walking; there are no room buttons to tap.",
            illustration: .hold
        ),
        OnboardingPage(
            id: 2,
            kicker: "Say what matters",
            title: "Say what you're showing. We'll tick it off.",
            body: "Point at the panel, the water heater, the appliances, and say what they are. The phone hears you, ticks the prompt, and saves what you said with the recording. Skip anything that doesn't apply.",
            illustration: .checklist
        ),
        OnboardingPage(
            id: 3,
            kicker: "Ready when you are",
            title: "You can fix anything afterwards.",
            body: "Rename rooms, drag a wall, add a note or photo. Your recording stays on this phone unless you export it or enable the debug live link. Next: permissions, then confirm your property.",
            illustration: .review
        )
    ]

    static let scriptBeats: [String] = [
        "This is a live walkthrough. We are recording.",
        "Name the room you are in.",
        "Walk the walls so we can measure the room.",
        "Show anything expensive to replace — appliances, TVs, furniture you care about.",
        "Show the panel, shutoffs, HVAC, water heater if they live here.",
        "Say how someone uses this room, and what tends to break.",
        "Say the name of what you're showing — it ticks itself off.",
        "Say when you enter another room. Tap Done walking after the whole home."
    ]

    /// What the walk asks you to show, in order. Saying the thing ticks it off.
    static let prompts: [WalkPrompt] = [
        WalkPrompt(title: "Electrical panel", ask: "Point at the breaker panel and say “this is the panel”.", category: "insurance",
                   keywords: ["electrical panel", "breaker panel", "breaker box", "fuse box", "breakers", "panel"]),
        WalkPrompt(title: "Water heater", ask: "Show the water heater. Mention the brand if you can see it.", category: "insurance",
                   keywords: ["water heater", "hot water tank", "hot water"]),
        WalkPrompt(title: "Heating & cooling", ask: "Show the furnace, AC or heat pump, and the thermostat.", category: "insurance",
                   keywords: ["furnace", "air conditioner", "ac unit", "a/c", "hvac", "heat pump", "thermostat"]),
        WalkPrompt(title: "Water shutoff", ask: "Show the main water shutoff and say where it is.", category: "maintenance",
                   keywords: ["water shutoff", "water shut off", "shutoff valve", "shut off valve", "main valve", "water main", "shutoff", "shut off"]),
        WalkPrompt(title: "Major appliances", ask: "Name the big appliances as you pass them: fridge, range, dishwasher, washer, dryer.", category: "insurance",
                   keywords: ["refrigerator", "fridge", "oven", "stove", "range", "dishwasher", "washer", "washing machine", "dryer", "microwave", "cooktop"]),
        WalkPrompt(title: "Valuables & serials", ask: "Show anything expensive to replace, and read a serial or model number if there is one.", category: "insurance",
                   keywords: ["serial number", "model number", "television", "tv", "piano", "artwork", "jewelry", "safe", "computer"]),
        WalkPrompt(title: "Filters & breakers to know", ask: "Say where the air filter lives and which breaker trips.", category: "maintenance",
                   keywords: ["air filter", "furnace filter", "filter", "which breaker", "breaker for", "breaker trips"]),
        WalkPrompt(title: "What often breaks", ask: "Anything that leaks, sticks, trips or needs a trick? Say it now.", category: "guidebook",
                   keywords: ["breaks", "broken", "leaks", "leak", "sticks", "trips", "trick", "problem", "issue", "finicky"]),
        WalkPrompt(title: "How this room is used", ask: "One line on how you use this room.", category: "guidebook",
                   keywords: ["we use this", "this room is", "this is where we", "used for", "mostly for"]),
    ]

    static var insuranceItems: [String] { prompts.filter { $0.category == "insurance" }.map(\.title) }
    static var maintenanceItems: [String] { prompts.filter { $0.category == "maintenance" }.map(\.title) }
    static var guidebookItems: [String] { prompts.filter { $0.category == "guidebook" }.map(\.title) }

    /// Build notes live here, not in the customer flow.
    static let buildNotes = [
        "Audio and camera video of the walk are recorded on the phone (not in the Simulator).",
        "The guide and specialist indicators are stand-ins; no model or chat runs yet.",
        "Rooms are measured boxes from where you walked, aligned to your first room's walls."
    ]

    static let videoFilename = "walk-video.mov"
    static let videoPlaceholderFilename = "walk-video.placeholder.txt"
    static let audioFilename = "walk-audio.m4a"
    static let videoPlaceholderBody = """
    HomeWalk video placeholder
    This capture ran in the Simulator, which has no camera. On a phone the walk is recorded to walk-video.mov.
    Pose samples and the floor plan are stored in plan.json.
    Spoken audio, if permission was granted, is walk-audio.m4a.
    An overseeing LLM and optional account-manager chat are UI placeholders.
    """
}
