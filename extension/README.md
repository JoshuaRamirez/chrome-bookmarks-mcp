# Bookmark Manager Utility

A general-purpose Chrome extension for managing **all** your bookmarks. Because
every change goes through Chrome's official `chrome.bookmarks` API, edits are
created inside Chrome's own model and therefore **sync durably** — unlike direct
edits to the bookmark file, which the sync engine discards on launch.

## Load it (one time)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select this `extension/` folder (inside the
   `chrome-bookmarks-mcp` plugin — typically
   `~/.claude/plugins/cache/RedJay/chrome-bookmarks-mcp/<version>/extension`)

The full manager opens automatically on first load. Re-open it any time from the
toolbar icon → **Open full manager →**.

## Two surfaces

**Toolbar popup** — quick-add the current tab into any folder (with a clean name).

**Manager page** (`manager.html`) — full management of the whole tree:

| Action | What it does |
|--------|--------------|
| New folder | Create a folder inside any chosen parent (incl. the bookmarks bar) |
| Add bookmark | Create a bookmark, targeting any folder |
| Per-folder `+url` / `+dir` | Add a bookmark / subfolder directly into that folder |
| `rename` / `move` / `del` | Edit, relocate, or delete folders and bookmarks |
| `edit` (bookmarks) | Change name **and** URL |
| Search | Live filter across all bookmarks; shows folder path; edit/move/del inline |
| Find duplicates | Group bookmarks sharing a URL; keep one, remove the rest |
| Export JSON | Download the whole tree as portable JSON (your backup) |
| Import JSON | Recreate an exported tree under any chosen folder |

Permanent roots (Bookmarks bar, Other bookmarks, Mobile) cannot be renamed,
moved, or deleted — only their contents.

## Architecture

- `lib/bookmarks.js` — `BookmarkStore`: the single wrapper over `chrome.bookmarks`
  (traversal, folder enumeration, dedupe, export/import). Shared by all pages.
- `manager.{html,css,js}` — the management UI (safe DOM construction, no innerHTML).
- `popup.{html,js}` — quick-add current tab.
- `background.js` — opens the manager on install.

## Permissions

- `bookmarks` — read/write bookmarks.
- `tabs` — read the current tab's title/URL for quick-add.

No network access, no data leaves the browser.
