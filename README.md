# Chrome Bookmarks MCP

<img src="extension/icons/icon-128.png" align="right" width="88" height="88" alt="Chrome Bookmarks MCP icon">

[![CI](https://github.com/JoshuaRamirez/chrome-bookmarks-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/JoshuaRamirez/chrome-bookmarks-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JoshuaRamirez/chrome-bookmarks-mcp?sort=semver)](https://github.com/JoshuaRamirez/chrome-bookmarks-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

Manage Chrome's **synced** bookmarks from Claude Code — list, search, add, move,
rename, deduplicate, and reorganize whole folder trees. Every edit goes through
Chrome's official `chrome.bookmarks` API, so changes are written into Chrome's
own model and **sync durably** across devices (unlike direct edits to the
bookmark file, which the sync engine discards on launch).

## How it works

Two coupled components talk over a localhost WebSocket:

```
Claude Code ──stdio──▶ MCP server ──ws://127.0.0.1:8765──▶ Chrome extension ──▶ chrome.bookmarks
              (this plugin)          (localhost bridge)      (load unpacked)      (synced store)
```

- **MCP server** (`dist/bundle.cjs`) — a stdio MCP server exposing 17 bookmark
  tools and 8 tab tools. It starts a localhost WebSocket bridge on port `8765`.
- **Chrome extension** (`extension/`) — dials into that bridge and runs each
  operation inside the browser's `chrome.bookmarks` context (and `chrome.tabs` /
  `chrome.tabGroups` for the tab tools).

The MCP server can only act while Chrome is open with the extension loaded; the
`bookmarks_status` tool reports whether the bridge is connected.

## Requirements

- **Node.js 18+** (the MCP host runs the bundled server)
- **Google Chrome** (or a Chromium browser supporting unpacked MV3 extensions)

## Install

### 1. The plugin (MCP server)

From the RedJay marketplace:

```
/plugin marketplace add JoshuaRamirez/claude-code-plugins
/plugin install chrome-bookmarks-mcp@RedJay
```

The server is pre-bundled (`dist/bundle.cjs`) — no `npm install` needed at
plugin-load time.

### Many sessions on one machine: run it once, through shared-mcp

The bridge port (8765) can be held by one process only, and every Claude Code
session starts its own copy of an MCP server. Register the server through
[shared-mcp](https://github.com/JoshuaRamirez/shared-mcp) so one long-lived
copy owns the port and the extension's socket, and each session is a thin
client of it:

```
claude mcp add chrome-bookmarks -s user -e BOOKMARK_WRITES=off -- \
  python3 ~/Developer/shared-mcp/shared_mcp.py connect --name chrome-bookmarks \
  --env BOOKMARK_WRITES -- "$(command -v node)" /abs/path/to/dist/bundle.cjs
```

A copy that can't bind the port keeps retrying (every `BOOKMARK_BRIDGE_RETRY_MS`,
default 2000) and takes it when the holder exits, and a copy exits when its
stdin closes, so an orphaned copy never keeps the port. Test:
`test/shared-sessions.mjs` (two sessions reading at once).

### 2. The Chrome extension (one time)

The extension lives in this plugin's `extension/` directory. After install,
find the plugin root (typically
`~/.claude/plugins/cache/RedJay/chrome-bookmarks-mcp/<version>/`), then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select the plugin's `extension/` folder
4. The full bookmark manager opens on first load; re-open any time from the
   toolbar icon

Not sure which folder to pick? Ask Claude to run `bookmarks_status` — while
disconnected it prints the **exact absolute path** to load (its `extension_dir`
field). Once loaded and Chrome is running, run it again to confirm the bridge is
connected.

## Tools

| Tool | Purpose |
|------|---------|
| `bookmarks_status` | Is the extension bridge connected? |
| `stats` | Count of folders and URLs |
| `list_folders` | Every folder with id, depth, and full path |
| `list_bookmarks` | Flat list of bookmarks (`{id,title,url,folder}`), optionally scoped to a folder path |
| `search_bookmarks` | Live filter across all bookmarks |
| `add_bookmark` | Create a bookmark, targeting any folder or path |
| `create_folder` | Create a folder under any parent or path |
| `ensure_folder_path` | Idempotently create a nested folder path |
| `update_bookmark` | Rename and/or change a bookmark's URL |
| `move_bookmark` | Relocate a bookmark or folder |
| `remove_bookmark` | Delete a bookmark or folder (optionally recursive) |
| `find_duplicates` | Group bookmarks sharing a URL |
| `remove_duplicates` | Keep one of each URL, remove the rest |
| `remove_empty_folders` | Prune folders with no descendants (supports `dry_run`) |
| `apply_moves` | Batch-move bookmarks from a plan TSV (supports `dry_run`) |
| `export_json` | Export the whole tree as portable JSON |
| `import_json` | Recreate an exported JSON tree under a target folder (backup restore) |

### Open tabs and tab groups

These act on the live tab strip. A tab that is moved or grouped stays loaded:
nothing is closed or reopened, so its page, history and scroll position survive.

| Tool | Purpose |
|------|---------|
| `list_tabs` | Open windows with their tab groups and tabs, in tab-strip order |
| `list_tab_groups` | Tab groups with id, window, title, colour and tab count |
| `group_tabs` | Put tabs into a group by id or title (joins the group with that title, else makes it); works across windows |
| `ungroup_tabs` | Take tabs out of their group |
| `move_tabs` | Move tabs to a position in the same or another window |
| `update_tab_group` | Rename, recolour, collapse or expand a group |
| `move_tab_group` | Move a whole group, with its tabs, within or between windows |
| `reload_extension` | Reload the companion extension from disk after its files change |

No tab tool closes a tab. `BOOKMARK_WRITES=off` makes these report-only too.

See **[examples/USAGE.md](examples/USAGE.md)** for a step-by-step walkthrough —
first-run check, adding to a folder, safe deduplication, and batch reorganization.

Destructive tools (`remove_*`, `apply_moves`) accept a `dry_run` flag; export
first for a backup.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `BOOKMARK_BRIDGE_PORT` | `8765` | WebSocket port the server listens on / the extension dials |
| `BOOKMARK_PLAN_FILE` | `~/.chrome-bookmarks-mcp/proposed-moves.tsv` | Default plan file for `apply_moves` |

If you change the port, update the extension's `bridge.js` to match.

## Troubleshooting

Run **`bookmarks_status`** first — when the bridge is disconnected it returns the
exact steps to fix it. Common cases:

| Symptom | Cause | Fix |
|---------|-------|-----|
| Tools error with *"Chrome bridge not connected"* | Extension not loaded, or Chrome is closed | Open Chrome; load the extension unpacked (see step 2 above) |
| Was working, now times out | Chrome was quit, or the MV3 service worker went idle | Re-open Chrome / click the toolbar icon once to wake the worker; the extension re-dials automatically within a few seconds |
| Still disconnected after loading | Port mismatch | The extension dials `ws://127.0.0.1:8765`; if you set `BOOKMARK_BRIDGE_PORT`, edit `BRIDGE_URL` in `extension/bridge.js` to match |
| `apply_moves` can't find its plan | No plan file at the default path | Pass `file_path`, or set `BOOKMARK_PLAN_FILE` |

The extension auto-reconnects (3s retry) if the MCP server restarts, so you rarely
need to reload it — just make sure Chrome is running.

## Build from source

```
npm install
npm run build      # esbuild → dist/bundle.cjs
npm test           # smoke + port-conflict suites (no browser needed)
npm run probe      # optional: live connectivity probe (needs the extension)
```

Contributing? See **[CONTRIBUTING.md](CONTRIBUTING.md)** — note that `dist/bundle.cjs`
is committed, so any `src/` change must be rebuilt and committed (CI enforces this).

## Privacy

No network access beyond the localhost bridge. Bookmarks never leave your
machine; the extension talks only to `127.0.0.1`. The tab tools send the titles
and addresses of your open tabs over that same localhost bridge, to the MCP
client that asked, and nowhere else.

## License

MIT © Joshua Ramirez
