# Repository Guidelines

## Project Structure & Module Organization

- Root `.mjs` files contain the Express server (`server.mjs`), WebSocket relay (`live-relay.mjs`), and capture evaluation/post-walk tools.
- `public/` contains browser JavaScript, HTML, CSS, and SVG assets for live scanning, capture review, and the plan comparison lab.
- `ios/HomeWalk/HomeWalk/` contains the Swift app, organized into `Capture/`, `Geometry/`, `Model/`, `Recording/`, `Storage/`, and `Views/`. Native tests live in sibling `HomeWalkTests/` and `HomeWalkUITests/` directories.
- Root `test-*.mjs` scripts cover browser/server behavior. Shared captures live in `test-fixtures/`; evaluation references live in `test-videos/ground-truth/`. Generated results belong in ignored `test-output/`.

## Build, Test, and Development Commands

Use Node.js 20+ and run commands from the repository root unless noted.

- `npm install`: install dependencies.
- `cp .env.example .env`: initialize local configuration; set `GEMINI_API_KEY` for model-backed features.
- `npm run dev` (or `npm start`): serve the app at `http://localhost:8787`; no separate web build is configured.
- `npm test`: run JavaScript syntax checks, SVG export checks, and HomeWalk/relay tests.
- `npm run test:homewalk`: run the focused geometry, plan, and relay suite.
- `node eval-capture.mjs <capture.homewalk>`: report measured-versus-tape dimensions and capture diagnostics.
- `open ios/HomeWalk/HomeWalk.xcodeproj`: open the native app; select the `HomeWalk` scheme to build or test. See `ios/HomeWalk/README.md` for `xcodebuild` commands.

## Coding Style & Naming Conventions

Match surrounding code: JavaScript uses ES modules, two-space indentation, semicolons, and camelCase identifiers. Use hyphenated filenames for browser modules and scripts. Swift uses four-space indentation, PascalCase types/files, and camelCase members. No dedicated formatter or linter is configured.

## Testing Guidelines

HomeWalk JavaScript tests use `node:test` and strict assertions; SVG checks use a custom assertion harness. Native tests use XCTest. Name JavaScript tests `test-<feature>.mjs` and Swift test files `<Feature>Tests.swift`. Add regression coverage for changed behavior; no numeric coverage threshold is configured. Keep Swift and JavaScript geometry consistent through shared fixtures and meter-based coordinates. Validate ARKit changes on a physical iPhone; Simulator uses synthetic geometry.

## Commit & Pull Request Guidelines

History uses short imperative subjects, such as “Build native-audio home scan demo.” Follow that style. PRs should describe the behavior change, link relevant issues, report validation, and include screenshots for UI changes. Keep API keys, private recordings, addresses, and generated outputs out of commits.
