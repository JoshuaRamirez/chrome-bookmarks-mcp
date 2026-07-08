# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [1.0.5]

### Changed
- `search_bookmarks` results now include each hit's **folder path** (via a new
  `BookmarkStore.searchWithPaths`), so you can see where a bookmark lives without
  a follow-up lookup. (The bare `chrome.bookmarks.search` returns only a
  `parentId`.)

### Added
- `test/bookmarkstore.mjs` — the extension's core `BookmarkStore` logic now runs
  under test in Node against a mock `chrome.bookmarks` tree (stats, folder paths,
  duplicate grouping, search-with-paths, export). Previously untested.

## [1.0.4]

### Added
- Bridge now tracks bind state; `bookmarks_status` distinguishes three cases:
  connected, listening-but-no-extension, and **port bind failure (EADDRINUSE)** —
  the last returns a targeted fix ("another server is already on this port; free
  it or change BOOKMARK_BRIDGE_PORT") instead of a misleading "not connected".
- `test/port-conflict.mjs` — CI test proving the EADDRINUSE diagnostic.

### Fixed
- `probe.mjs` usage comment (`npm run probe`, not `node probe.mjs`).

## [1.0.3]

### Added
- Extension icons (16/48/128) — a bookmark-ribbon glyph, so the toolbar button
  and `chrome://extensions` entry show real branding instead of the default
  puzzle piece. Source SVG committed at `extension/icons/icon.svg`.
- `examples/USAGE.md` — a step-by-step walkthrough (first-run check, folder-
  targeted add, safe dedupe, batch reorganization), linked from the README.

### Fixed
- README described `list_bookmarks` as folder-scoped; corrected to "full nested
  bookmark tree" to match the actual tool.

## [1.0.2]

### Added
- `npm test` — a stdio smoke test that boots the bundle and asserts the protocol
  handshake, all 16 tools, and disconnected-state guidance.
- GitHub Actions CI (`.github/workflows/ci.yml`): build, smoke test, and a guard
  that fails if the committed `dist/bundle.cjs` is stale relative to source.
- `SECURITY.md` documenting the localhost-only threat model and change scope.

## [1.0.1]

### Changed
- `bookmarks_status` now returns step-by-step setup guidance when the extension
  bridge is disconnected, instead of a bare `{connected, port}` — so a first-run
  user (or Claude) sees exactly what to do next.
- The "bridge not connected" error now points at the `bookmarks_status` tool for
  recovery steps.

### Added
- README **Troubleshooting** section covering the most common first-run issues
  (extension not loaded, Chrome closed, port mismatch, MV3 service-worker sleep).
- This changelog.

## [1.0.0]

### Added
- Initial release: MCP server exposing 16 Chrome bookmark tools
  (`list`, `search`, `add`, `move`, `rename`, `remove`, `find_duplicates`,
  `remove_duplicates`, `remove_empty_folders`, `apply_moves`, `export_json`, …).
- Companion Chrome extension (`extension/`) that executes operations via
  `chrome.bookmarks`, so every edit syncs durably.
- Pre-bundled server artifact (`dist/bundle.cjs`, esbuild) — no `npm install`
  required at plugin-load time.
- Portable `apply_moves` plan path via `BOOKMARK_PLAN_FILE`; configurable bridge
  port via `BOOKMARK_BRIDGE_PORT`.
