# Contributing

Thanks for improving Chrome Bookmarks MCP. This project is small and has a couple
of non-obvious rules worth knowing before you open a PR.

## Repository layout

```
src/            MCP server sources (server.js, bridge.js, probe.mjs)
dist/bundle.cjs Pre-bundled, committed server artifact (esbuild → CommonJS)
extension/      Chrome extension (MV3) — the browser half of the bridge
test/           Node smoke + robustness tests (no browser needed)
tools/          Auxiliary scripts (classify.py)
.claude-plugin/ plugin.json — Claude Code plugin manifest
.mcp.json       Points Claude Code at dist/bundle.cjs
```

The server and the extension talk over a localhost WebSocket. The server binds
the port; the extension dials it. See the README for the data-flow diagram.

## Build and test

```
npm install
npm run build      # esbuild src/server.js → dist/bundle.cjs
npm test           # boots the bundle; asserts protocol, tools, and diagnostics
```

`npm test` runs two suites, neither of which needs Chrome:
- `test/smoke.mjs` — handshake, all 16 tools present, disconnected-state guidance.
- `test/port-conflict.mjs` — a second server on a taken port reports EADDRINUSE.

## The one rule CI enforces: rebuild the bundle

`dist/bundle.cjs` is **committed** so the plugin needs no `npm install` at
install time. That means: **if you change anything under `src/`, you must run
`npm run build` and commit the updated `dist/bundle.cjs` in the same PR.** CI
fails if the committed bundle is stale relative to source
(`.github/workflows/ci.yml` → "Verify committed bundle is up to date").

## Editing the extension

The extension is plain MV3 — no build step. Load it unpacked
(`chrome://extensions` → Load unpacked → `extension/`) and reload after edits.
Keep DOM construction injection-safe (no `innerHTML` with untrusted input); the
existing UI builds nodes explicitly.

## Adding a tool

1. Add the `server.tool(...)` registration in `src/server.js`.
2. Add the matching `case` in `extension/bridge.js` `bridgeDispatch`, backed by a
   method on `BookmarkStore` (`extension/lib/bookmarks.js`) where appropriate.
3. Add its name to `EXPECTED_TOOLS` in `test/smoke.mjs`.
4. `npm run build && npm test`, commit the bundle.

## Versioning and release

SemVer. A user-facing change bumps the patch/minor in **three** places, kept in
lockstep:
- `package.json`
- `.claude-plugin/plugin.json`
- the `McpServer({ version })` string in `src/server.js`

Docs-only changes do not bump the version. Publishing to the RedJay marketplace
is a separate step (update its `marketplace.json` entry to the new version).

## Commit style

Conventional Commits with a leading emoji, e.g.
`✨ feat(onboarding): …`, `🩹 fix(bridge): …`, `📝 docs: …`. Prefer small,
focused commits.
