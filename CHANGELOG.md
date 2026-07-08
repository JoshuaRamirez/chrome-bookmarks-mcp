# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

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
