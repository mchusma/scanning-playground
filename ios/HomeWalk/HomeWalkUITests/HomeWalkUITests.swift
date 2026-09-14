import XCTest

final class HomeWalkUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLaunchShowsWalkControls() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launch()
        confirmProperty(app)
        assertWalkChrome(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["walk-prompt"].waitForExistence(timeout: 8)
                || app.staticTexts[WalkPrompt.chestHeight].waitForExistence(timeout: 2)
        )
        XCTAssertFalse(app.buttons["Add corner"].exists)
        XCTAssertFalse(app.buttons["add-corner"].exists)
    }

    func testStartWalkCapturesWithoutRoomButtons() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--hear", "okay this is the breaker panel and here's the dishwasher"]
        app.launch()
        confirmProperty(app)
        let start = app.buttons["start-walk"]
        XCTAssertTrue(start.waitForExistence(timeout: 8))
        start.tap()
        XCTAssertFalse(app.buttons["through-door"].exists)
        XCTAssertTrue(app.buttons["done-walk"].exists)
        XCTAssertFalse(app.buttons["name-room"].exists)
        let capture = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        capture.name = "Capture only"
        capture.lifetime = .keepAlways
        add(capture)
        // All prompts in a row, any order; only speech ticks them.
        XCTAssertTrue(app.descendants(matching: .any)["prompt-row"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["prompt-skip"].exists)
        XCTAssertFalse(app.buttons["prompt-done"].exists)
        let panel = app.descendants(matching: .any)["prompt-Electrical panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 3))
        let ticked = NSPredicate(format: "value == 'done'")
        expectation(for: ticked, evaluatedWith: panel)
        expectation(for: ticked, evaluatedWith: app.descendants(matching: .any)["prompt-Major appliances"])
        waitForExpectations(timeout: 6)
        XCTAssertEqual(app.descendants(matching: .any)["prompt-Water heater"].value as? String, "open")
        XCTAssertTrue(app.descendants(matching: .any)["captured-chips"].exists, "heard items pop in as chips")
        panel.tap()
        XCTAssertTrue(app.descendants(matching: .any)["prompt-hint"].waitForExistence(timeout: 2), "tapping a chip only shows its hint")
        XCTAssertTrue(app.descendants(matching: .any)["overseer-placeholder"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["account-manager-placeholder"].exists)
    }

    func testSecondLaunchShowsWalkControls() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launch()
        confirmProperty(app)
        assertWalkChrome(app)
    }

    func testPropertyMustBeConfirmedBeforeWalkAndSaveReachesReview() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launch()
        XCTAssertTrue(app.textFields["property-address"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["start-walk"].exists)
        XCTAssertFalse(app.buttons["confirm-property"].exists)
        confirmProperty(app)
        app.buttons["start-walk"].tap()
        XCTAssertTrue(app.buttons["done-walk"].waitForExistence(timeout: 4))
        app.buttons["done-walk"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["plan-editor"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Start another walk"].exists || app.buttons["continue-capture"].exists)
        XCTAssertFalse(app.buttons["Continue walking"].exists)
    }

    func testRecordedReplayScrubbingAndVideoGap() throws {
        // `npm run simulator:replay` installs the private fixture into this
        // Simulator first. Ordinary UI runs need no private recording.
        guard ProcessInfo.processInfo.environment["HOMEWALK_REPLAY_UI_TEST"] == "1" else {
            throw XCTSkip("Prepare replay and set TEST_RUNNER_HOMEWALK_REPLAY_UI_TEST=1")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--replay"]
        app.launch()
        let confirm = app.buttons["confirm-property"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        for _ in 0..<4 where !confirm.isHittable { app.swipeUp() }
        confirm.tap()
        let start = app.buttons["start-walk"]
        XCTAssertTrue(start.waitForExistence(timeout: 6))
        start.tap()
        let playPause = app.buttons["replay-play-pause"]
        XCTAssertTrue(playPause.waitForExistence(timeout: 6))
        playPause.tap()
        app.sliders["replay-scrubber"].adjust(toNormalizedSliderPosition: 0.01)
        let entry = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        entry.name = "Real walk replay - initial GPS and compass alignment"
        entry.lifetime = .keepAlways
        add(entry)
        app.sliders["replay-scrubber"].adjust(toNormalizedSliderPosition: 0.3)
        let middle = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        middle.name = "Real walk replay - video and path"
        middle.lifetime = .keepAlways
        add(middle)
        app.buttons["replay-restart"].tap()
        let count = app.staticTexts["replay-pose-count"]
        XCTAssertTrue(count.label.hasPrefix("0 /"), "restart removes future poses")
        app.buttons["replay-speed"].tap()
        app.buttons["16×"].tap()
        playPause.tap()
        let complete = NSPredicate(format: "label == '368 / 368 poses'")
        expectation(for: complete, evaluatedWith: count)
        waitForExpectations(timeout: 25)
        XCTAssertTrue(app.staticTexts["replay-video-gap"].exists)
        let tail = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        tail.name = "Real walk replay - audio and pose tail"
        tail.lifetime = .keepAlways
        add(tail)
        app.buttons["done-walk"].tap()
        XCTAssertTrue(app.staticTexts["replay-result"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["replay-result"].label.contains("368 poses"))
        let result = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        result.name = "Real walk replay - current capture result"
        result.lifetime = .keepAlways
        add(result)
    }

    func testPlanAssistantOpensFromReview() throws {
        guard ProcessInfo.processInfo.environment["HOMEWALK_ASSISTANT_UI_TEST"] == "1" else {
            throw XCTSkip("Start the local server and set TEST_RUNNER_HOMEWALK_ASSISTANT_UI_TEST=1")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launch(); confirmProperty(app)
        app.buttons["start-walk"].tap()
        app.buttons["done-walk"].tap()
        let open = app.buttons["open-plan-assistant"]
        XCTAssertTrue(open.waitForExistence(timeout: 8)); open.tap()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 10))
        XCTAssertTrue(web.staticTexts["Keep refining it"].waitForExistence(timeout: 15))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Plan assistant in Simulator"
        screenshot.lifetime = .keepAlways; add(screenshot)
        let field = web.textFields["Room name"]
        XCTAssertTrue(field.exists)
        field.tap()
        field.typeText("Test kitchen")
        web.buttons["Rename"].tap()
        XCTAssertTrue(web.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Version 2'")).firstMatch.waitForExistence(timeout: 8))
        app.navigationBars.buttons["Done"].tap()
        XCTAssertEqual(app.textFields["rename-room"].value as? String, "Test kitchen")
    }

    private func confirmProperty(_ app: XCUIApplication) {
        let load = app.buttons["load-property"]
        XCTAssertTrue(load.waitForExistence(timeout: 8))
        load.tap()
        let confirm = app.buttons["confirm-property"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 4))
        let preview = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        preview.name = "Property preview"
        preview.lifetime = .keepAlways
        add(preview)
        if !confirm.isHittable { app.swipeUp() }
        confirm.tap()
        XCTAssertTrue(app.buttons["start-walk"].waitForExistence(timeout: 8))
    }

    private func assertWalkChrome(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["start-walk"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["walk-prompt"].exists
            || app.staticTexts[WalkPrompt.chestHeight].exists)
        XCTAssertTrue(app.buttons["open-checklist"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["mini-map"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["current-room-label"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["tracking-indicator"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["overseer-placeholder"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["account-manager-placeholder"].exists)
    }
}

private enum WalkPrompt {
    static let chestHeight = "Hold the phone at chest height, tilt it down a bit, walk along the walls. Talk as you go."
}
