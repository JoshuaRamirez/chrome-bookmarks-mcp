# Security

## Threat model

This plugin has two components that talk over a **localhost-only** WebSocket:

- **MCP server** (`dist/bundle.cjs`) binds a WebSocket server to
  `127.0.0.1:8765` (configurable via `BOOKMARK_BRIDGE_PORT`). It is not reachable
  from other hosts.
- **Chrome extension** (`extension/`) requests the `bookmarks` and `tabs`
  permissions and connects outward to that localhost port.

What this means:

- **No remote network access.** Bookmark data never leaves the machine; the only
  socket is loopback. The extension declares no host permissions and makes no
  external requests.
- **No telemetry.** Nothing is logged off-device.
- **Bridge is unauthenticated.** Any local process able to open a socket to the
  chosen port can drive bookmark operations while Chrome is running with the
  extension loaded. This matches the trust boundary of a single-user desktop: a
  local attacker already running code as you can manipulate bookmarks directly.
  If you run untrusted local software, pick a non-default `BOOKMARK_BRIDGE_PORT`
  and be aware of this surface.

## Scope of changes

The extension operates only on `chrome.bookmarks`. It cannot read page content,
browsing history, cookies, or credentials. The `tabs` permission is used solely
to read the current tab's title and URL for the quick-add popup.

## Destructive operations

`remove_bookmark`, `remove_duplicates`, `remove_empty_folders`, and `apply_moves`
mutate or delete bookmarks. The latter three support `dry_run` for a no-op
preview; `export_json` produces a full backup. Take an export before large
reorganizations.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the
maintainer. Please do not file public issues for undisclosed vulnerabilities.
