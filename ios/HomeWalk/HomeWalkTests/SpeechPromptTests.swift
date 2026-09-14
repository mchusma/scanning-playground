import XCTest
@testable import HomeWalk

/// Saying the thing ticks the prompt, captures the item with its phrase, and
/// pins it to the room being walked. Skips are reversible. Nothing here
/// touches geometry.
final class SpeechPromptTests: XCTestCase {
    private func hit(_ x: Double, _ z: Double) -> PlacementHit { SimulatedHit.downward(x: x, z: z) }

    func testMatcherPrefersLongPhrasesAndDedupes() {
        let hits = ItemMatcher.match("Okay, this is the water heater, and next to it the electrical panel — the panel is a 200 amp.")
        XCTAssertEqual(hits.map(\.label), ["electrical panel", "water heater"], "longest phrases first, 'panel' not re-matched, 'water' alone never matches")
        XCTAssertEqual(ItemMatcher.match("we mostly hang out in here").count, 0)
        XCTAssertEqual(Set(ItemMatcher.match("The fridge and the dishwasher.").map(\.label)), ["refrigerator", "dishwasher"])
        // Keyword sets must not overlap: one phrase, one prompt.
        for p in WalkCopy.prompts {
            for k in p.keywords {
                let owners = ItemMatcher.prompts(satisfiedBy: k, in: WalkCopy.prompts).map(\.title)
                XCTAssertEqual(owners, [p.title], "keyword '\(k)' is claimed by \(owners)")
            }
        }
        XCTAssertEqual(ItemMatcher.prompts(satisfiedBy: "the breaker panel is here", in: WalkCopy.prompts).map(\.title), ["Electrical panel"])
        let satisfied = ItemMatcher.prompts(satisfiedBy: "here's the furnace", in: WalkCopy.prompts).map(\.title)
        XCTAssertEqual(satisfied, ["Heating & cooling"])
        XCTAssertEqual(ItemMatcher.prompts(satisfiedBy: "this room is for the kids", in: WalkCopy.prompts).map(\.title), ["How this room is used"])
        print("ASSERT: keyword matcher is longest-first, deduped, and maps phrases to prompts")
    }

    func testHearingTicksPromptsCapturesItemsAndPinsThemToTheRoom() throws {
        let session = CaptureSession(name: "Hear", capabilities: .simulated)
        session.updateTracking(.normal)
        XCTAssertEqual(session.nextPrompt?.title, "Electrical panel")
        _ = session.beginWalk(hit(0, 0))
        _ = session.sampleWalk(hit(4, 0))

        // Partial text lands first: the item appears immediately…
        let added = session.hear("and this is the dish", isFinal: false)
        XCTAssertTrue(added.isEmpty, "no item until a whole word matches")
        let added2 = session.hear("and this is the dishwasher", isFinal: false)
        XCTAssertEqual(added2.map(\.label), ["dishwasher"])
        XCTAssertEqual(added2.first?.promptTitle, "Major appliances")
        XCTAssertTrue(session.checklist.first { $0.title == "Major appliances" }!.done, "prompt ticked by hearing it")
        XCTAssertNotNil(session.checklist.first { $0.title == "Major appliances" }!.evidenceItemID)
        // …and the final sentence does not double-count it, but is stored as transcript.
        let t = Date().timeIntervalSince1970
        let again = session.hear("And this is the dishwasher, it's a Bosch.", isFinal: true, at: t, startedAt: t - 4)
        XCTAssertTrue(again.isEmpty)
        XCTAssertEqual(session.capturedItems.count, 1)
        XCTAssertEqual(session.transcript.count, 1)
        XCTAssertEqual(session.transcript[0].startedAt, t - 4, accuracy: 1e-6)
        XCTAssertNil(session.capturedItems[0].roomID, "room has no id while it is being walked")

        // Prompt order: the electrical panel is still first; skipping it moves on.
        XCTAssertEqual(session.nextPrompt?.title, "Electrical panel")
        session.skipChecklistItem(session.nextPrompt!.id)
        XCTAssertEqual(session.nextPrompt?.title, "Water heater")
        // Hearing the panel later un-skips it.
        _ = session.hear("oh and the breaker panel is here", isFinal: true)
        let panel = session.checklist.first { $0.title == "Electrical panel" }!
        XCTAssertTrue(panel.done)
        XCTAssertNil(panel.skippedAt)

        // Closing the room attaches everything heard during it.
        _ = session.throughDoor()
        let room = session.rooms[0]
        XCTAssertTrue(session.capturedItems.allSatisfy { $0.roomID == room.id })
        XCTAssertTrue(session.transcript.allSatisfy { $0.roomID == room.id })

        // Round trip.
        let restored = try CaptureSession.fromJSON(session.exportedJSON())
        XCTAssertEqual(restored.capturedItems.count, 2)
        XCTAssertEqual(restored.transcript.count, 2)
        XCTAssertEqual(restored.checklist.filter(\.done).count, 2)
        print("ASSERT: heard items tick prompts, dedupe across partial/final, attach to the room on close, and export")
    }

    func testSkipIsReversibleAndManualTickClearsSkip() {
        let session = CaptureSession(name: "Skip", capabilities: .simulated)
        let first = session.nextPrompt!
        session.skipChecklistItem(first.id)
        XCTAssertNotEqual(session.nextPrompt?.id, first.id)
        session.unskipChecklistItem(first.id)
        XCTAssertEqual(session.nextPrompt?.id, first.id)
        session.skipChecklistItem(first.id)
        session.toggleChecklistItem(first.id)
        let item = session.checklist.first { $0.id == first.id }!
        XCTAssertTrue(item.done)
        XCTAssertNil(item.skippedAt)
        XCTAssertNotNil(item.doneAt)
        print("ASSERT: skip is reversible; a manual tick clears a skip")
    }

    func testLegacyChecklistWithoutNewFieldsDecodes() throws {
        let json = """
        {"schemaVersion":1,"sessionID":"6C0A5A2E-1E3E-4B9E-9B1D-2B4E7B1E0002","createdAt":1789000000,"name":"Old","appVersion":"0.1.0",
         "deviceCapabilities":{"worldTrackingSupported":false,"lidarDepthSupported":false,"sceneReconstructionSupported":false,"captureMode":"simulated"},
         "rooms":[],"doorways":[],"observations":[],"events":[],"mismatches":[],
         "inProgress":{"phase":"awaitingFloor","points":[],"checklist":[{"id":"6C0A5A2E-1E3E-4B9E-9B1D-2B4E7B1E0003","category":"insurance","title":"Electrical panel shown","done":true,"notes":""}]}}
        """
        let session = try CaptureSession.fromJSON(Data(json.utf8))
        XCTAssertEqual(session.checklist.count, 1)
        XCTAssertTrue(session.checklist[0].done)
        XCTAssertNil(session.checklist[0].prompt, "old title has no prompt; still decodes")
        XCTAssertNil(session.nextPrompt)
        print("ASSERT: yesterday's checklists still open")
    }
}
