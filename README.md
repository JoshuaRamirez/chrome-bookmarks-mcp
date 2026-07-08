# Chrome Bookmarks MCP

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

- **MCP server** (`dist/bundle.cjs`) — a stdio MCP server exposing 16 bookmark
  tools. It starts a localhost WebSocket bridge on port `8765`.
- **Chrome extension** (`extension/`) — dials into that bridge and runs each
  operation inside the browser's `chrome.bookmarks` context.

The MCP server can only act while Chrome is open with the extension loaded; the
`bookmarks_status` tool reports whether the bridge is connected.

## Install

### 1. The plugin (MCP server)

From the RedJay marketplace:

```
/plugin marketplace add JoshuaRamirez/claude-code-plugins
/plugin install chrome-bookmarks-mcp@RedJay
```

The server is pre-bundled (`dist/bundle.cjs`) — no `npm install` needed at
plugin-load time.

### 2. The Chrome extension (one time)

The extension lives in this plugin's `extension/` directory. After install,
find the plugin root (typically
`~/.claude/plugins/cache/RedJay/chrome-bookmarks-mcp/<version>/`), then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select the plugin's `extension/` folder
4. The full bookmark manager opens on first load; re-open any time from the
   toolbar icon

Once the extension is loaded and Chrome is running, ask Claude to run
`bookmarks_status` to confirm the bridge is connected.

## Tools

| Tool | Purpose |
|------|---------|
| `bookmarks_status` | Is the extension bridge connected? |
| `stats` | Count of folders and URLs |
| `list_folders` | Every folder with id, depth, and full path |
| `list_bookmarks` | Bookmarks, optionally within a folder |
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

Destructive tools (`remove_*`, `apply_moves`) accept a `dry_run` flag; export
first for a backup.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `BOOKMARK_BRIDGE_PORT` | `8765` | WebSocket port the server listens on / the extension dials |
| `BOOKMARK_PLAN_FILE` | `~/.chrome-bookmarks-mcp/proposed-moves.tsv` | Default plan file for `apply_moves` |

If you change the port, update the extension's `bridge.js` to match.

## Build from source

```
npm install
npm run build      # esbuild → dist/bundle.cjs
npm run probe      # optional: connectivity probe
```

## Privacy

No network access beyond the localhost bridge. Bookmarks never leave your
machine; the extension talks only to `127.0.0.1`.

## License

MIT © Joshua Ramirez
