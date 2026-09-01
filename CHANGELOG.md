# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [1.1.9]

### Fixed
- `list_bookmarks` / `listBookmarks` now rejects a provided `folder_path` that
  normalizes to empty (`/`, `///`, whitespace-only) with `empty path`, matching
  `ensurePath` and `apply_moves`. Omitting `folder_path` still lists everything.

## [1.1.8]

### Fixed
- `list_bookmarks` / `listBookmarks` now matches `folder_path` case-insensitively
  (trim + lowercase + rejoin), so `bookmarks bar/dev` and USAGE `Other Bookmarks`
  return the same hits as Chrome's real titles. Emitted `folder` strings keep
  Chrome's casing. No short-alias expansion (`bar` / `other` / `mobile`).

## [1.1.7]

### Fixed
- `search_bookmarks` / `searchWithPaths` no longer returns folder nodes (no
  `url`) from `chrome.bookmarks.search`. Hits stay title/URL bookmarks with
  folder path — the same filter `listBookmarks`, `findDuplicates`, and the
  manager UI already apply.

## [1.1.6]

### Fixed
- Permanent-root detection no longer substring-matches `bar` / `other` /
  `mobile`. `Sidebar/Dev`, `Mother/Kids`, and `Automobile/Cars` are rejected
  the same way as `Work/…` (`top-level folder "…" not found`). Short aliases
  (`bar`, `toolbar`, `other`, `mobile`) and the full root names still work.
  `apply_moves` dry_run and live `ensurePath` stay on the same allowlist
  (`Map`, so `constructor` / `toString` / `__proto__` are not aliases).

## [1.1.5]

### Fixed
- `remove_empty_folders` dry_run now reports the same cascade live apply would
  delete: after an empty child is listed, its parent is treated as empty too
  (instead of trusting a fresh `get_tree` that still contains those children).
  dry_run still does not call `remove`. Permanent roots stay skipped; folders
  that contain bookmarks (or non-empty folders) are not listed.

## [1.1.4]

### Fixed
- `apply_moves` dry_run now rejects proposed destinations whose top level is not
  a permanent root (`Bookmarks bar` / `Other bookmarks` / `Mobile bookmarks`,
  including the same bar/toolbar, other, mobile aliases as `ensurePath`) or
  whose path is empty. Those rows are reported in `errors` and no longer
  increment `moved`. Dry_run stays browser-free and does not create folders;
  `DELETE?` skip / `delete_junk` is unchanged.

## [1.1.3]

### Changed
- Tool descriptions for `import_json` and `apply_moves` now state that a folder
  path's top level must be a permanent root (`Bookmarks bar`, `Other bookmarks`,
  or `Mobile bookmarks`) — the same rule `add_bookmark`, `create_folder`,
  `move_bookmark`, and `ensure_folder_path` already named. `apply_moves` notes
  the exception for the literal `DELETE?` when `delete_junk` is used. Helps the
  driving model target folders correctly on the first try.

## [1.1.2]

### Changed
- Tool descriptions for `add_bookmark`, `create_folder`, and `move_bookmark` now
  state that a folder path's top level must be a permanent root (`Bookmarks bar`,
  `Other bookmarks`, or `Mobile bookmarks`) — previously only `ensure_folder_path`
  said so. Helps the driving model target folders correctly on the first try.

## [1.1.1]

### Fixed
- Manager UI: operations (`rename`, `move`, `delete`, folder/bookmark creation)
  no longer fail silently. A global rejection handler surfaces any
  `chrome.bookmarks` error (e.g. moving a folder into its own descendant) in a
  modal instead of a no-op.

### Changed
- Manager UI: replaced the two remaining `alert()` calls (import result/errors)
  with the same modal used elsewhere — consistent, non-blocking messaging.

## [1.1.0]

### Added
- **`import_json` tool** — recreate a previously exported bookmark JSON under a
  target folder (`into_path`, default `Other bookmarks`). Completes the
  export/import pair for backup and restore. Does not deduplicate. Covered by a
  new `BookmarkStore.importInto` test (folder created before its children) and
  the tool-presence smoke check (now 17 tools).

## [1.0.9]

### Changed
- `list_bookmarks` now returns a **flat array** of `{id, title, url, folder}` and
  accepts an optional `folder_path` to scope results to a folder (and its
  subfolders). Previously it returned the entire raw nested tree, which for a
  large collection is an enormous payload that can overflow the client's context.
  Covered by two new `BookmarkStore` tests.

## [1.0.8]

### Docs / Tests
- Add `examples/sample-plan.tsv` — a working `apply_moves` plan — and document the
  format in USAGE.md. The apply-moves test now runs a dry-run over it and asserts
  the move/skip/folder counts (dry-run parses without touching the browser).

### Security
- Bump the esbuild build dependency to 0.25.x, clearing the moderate advisory
  GHSA-67mh-4wv8-2f99 (esbuild dev-server request exposure). esbuild is build-only
  and its dev server is never used here, so runtime exposure was nil; this clears
  `npm audit` for anyone building from source. Bundle rebuilt; behavior unchanged
  (all four test suites pass). `zod` intentionally held at 3.x (v4 is a breaking
  major with no security driver).

## [1.0.7]

### Changed
- `apply_moves` now returns a clear, actionable message when the plan file is
  missing or empty (name the path, how to supply one) instead of a raw `ENOENT`.
- `export_json` wraps write failures with the target path and cause.

### Added
- `test/apply-moves.mjs` — asserts the missing-plan-file message via the MCP
  protocol (no browser needed).

## [1.0.6]

### Added
- When disconnected, `bookmarks_status` now includes `extension_dir` — the
  **exact absolute path** to the companion extension — and the "Load unpacked"
  step names that path directly, so there is no guessing which folder to select.

### Fixed
- Resolved the extension path via `__dirname` (with an ESM `import.meta.url`
  fallback); esbuild leaves `import.meta.url` undefined in the CJS bundle, which
  would otherwise have crashed server startup. The smoke test now asserts
  `extension_dir` resolves to a real manifest, guarding against a regression.

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
