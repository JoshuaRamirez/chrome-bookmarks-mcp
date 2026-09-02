#!/usr/bin/env node
// chrome-bookmarks-mcp — an MCP server exposing Chrome bookmark management.
// It runs a localhost WebSocket bridge that the Bookmark Manager extension
// connects to; each MCP tool forwards an operation to the extension, which
// executes it via chrome.bookmarks (so every change syncs durably).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.js";
import { splitPath } from "./folder-path.js";

// Fallback location for an apply_moves plan when no explicit file_path is given.
// Overridable via BOOKMARK_PLAN_FILE; otherwise a stable per-user path.
const PLAN_DEFAULT =
  process.env.BOOKMARK_PLAN_FILE ||
  join(homedir() || tmpdir(), ".chrome-bookmarks-mcp", "proposed-moves.tsv");

// Absolute path to the companion Chrome extension, resolved relative to this
// file's location. The server ships alongside extension/ (both at the plugin
// root: dist/bundle.cjs → ../extension; src/server.js → ../extension). We hand
// this exact path to the user for chrome://extensions → "Load unpacked".
const EXTENSION_DIR = (() => {
  // Works both as the CJS bundle (Node provides __dirname) and as ESM source
  // (import.meta.url). esbuild leaves import.meta.url undefined in CJS output,
  // so __dirname must be tried first.
  const here = typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../extension", "./extension"]) {
    const p = resolve(here, rel);
    if (existsSync(join(p, "manifest.json"))) return p;
  }
  return resolve(here, "../extension"); // best-effort default if not found
})();

const PORT = Number(process.env.BOOKMARK_BRIDGE_PORT || 8765);
const bridge = new Bridge(PORT);
bridge.start();

const server = new McpServer({ name: "chrome-bookmarks", version: "1.1.12" });

// Wrap a value as MCP text content.
const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }]
});

// Allowlist of first-segment aliases for Chrome's three permanent roots.
// Exact match after lowercasing and collapsing whitespace — keep in lockstep
// with permanentRootAlias in extension/bridge.js. Substring tests falsely
// accept Sidebar / Mother / Automobile (they contain bar / other / mobile).
const PERMANENT_ROOT_ALIASES = new Map([
  ["bar", ["bookmarks-bar", "1"]],
  ["toolbar", ["bookmarks-bar", "1"]],
  ["bookmarks bar", ["bookmarks-bar", "1"]],
  ["bookmarks-bar", ["bookmarks-bar", "1"]],
  ["other", ["other", "2"]],
  ["other bookmarks", ["other", "2"]],
  ["mobile", ["mobile", "3"]],
  ["mobile bookmarks", ["mobile", "3"]],
]);

function permanentRootAlias(segment) {
  const key = String(segment || "").toLowerCase().replace(/\s+/g, " ").trim();
  return PERMANENT_ROOT_ALIASES.get(key) || null;
}

// Mirror ensurePath's first-segment rule (extension/bridge.js) without Chrome:
// empty path is invalid; otherwise the top level must alias a permanent root.
// Live apply still calls ensure_path.
function assertPermanentRoot(segments) {
  if (!segments.length) throw new Error("empty path");
  if (!permanentRootAlias(segments[0])) {
    throw new Error(`top-level folder "${segments[0]}" not found; use "Bookmarks bar", "Other bookmarks", or "Mobile bookmarks"`);
  }
}

// Resolve a folder target to an id: prefer parent_id, else ensure the path.
// A provided path (including "") is never replaced by fallback — split it and
// throw "empty path" when nothing remains, matching ensurePath / listBookmarks.
// fallback is used only when path is null/undefined (omitted). move_bookmark
// passes fallback=null so omit-both still returns null for its own error.
async function resolveFolder(parent_id, path, fallback = "Bookmarks bar") {
  if (parent_id) return parent_id;
  const raw = path != null ? path : fallback;
  if (raw == null) return null;
  const segments = splitPath(raw);
  if (!segments.length) throw new Error("empty path");
  const folder = await bridge.call("ensure_path", { path: segments });
  return folder.id;
}

server.tool("bookmarks_status",
  "Report whether the Chrome extension bridge is connected and on what port. When disconnected, returns step-by-step setup guidance — call this first if any other tool fails to reach the browser.",
  {},
  async () => {
    const s = bridge.status();
    if (s.connected) {
      return ok({ connected: true, port: s.port, message: "Extension bridge connected — all bookmark tools are ready." });
    }
    // The port never bound — almost always another server instance holding it.
    if (s.bindError) {
      const inUse = s.bindError.code === "EADDRINUSE";
      return ok({
        connected: false,
        listening: false,
        port: s.port,
        message: inUse
          ? `Could not bind port ${s.port} (EADDRINUSE) — another process is already using it, most likely a second copy of this server.`
          : `The bridge failed to start on port ${s.port}: ${s.bindError.message}`,
        fix: [
          `Stop the other process using port ${s.port} (e.g. another running chrome-bookmarks server), or`,
          "Set BOOKMARK_BRIDGE_PORT to a free port for this server, and set the matching BRIDGE_URL in extension/bridge.js.",
          "Then restart and re-run bookmarks_status."
        ]
      });
    }
    // Port is bound and waiting; the extension simply hasn't dialed in yet.
    return ok({
      connected: false,
      listening: s.listening,
      port: s.port,
      extension_dir: EXTENSION_DIR,
      message: "Extension bridge NOT connected. The server is listening, but the companion Chrome extension hasn't connected yet.",
      fix: [
        "Make sure Google Chrome is open.",
        "Open chrome://extensions and enable Developer mode (top-right).",
        `Click 'Load unpacked' and select this exact folder: ${EXTENSION_DIR}`,
        `The extension dials ws://127.0.0.1:${s.port}. If you set BOOKMARK_BRIDGE_PORT to a non-default port, update BRIDGE_URL in extension/bridge.js to match.`,
        "Once loaded, re-run bookmarks_status to confirm."
      ]
    });
  });

server.tool("list_bookmarks",
  "List bookmarks as a flat array of {id, title, url, folder}. Optionally scope to a folder path (e.g. 'Bookmarks bar/Dev') to avoid returning the whole tree; omit to list everything.",
  { folder_path: z.string().optional().describe("only list bookmarks within this folder path and its subfolders") },
  async ({ folder_path }) => ok(await bridge.call("list_bookmarks", { folderPath: folder_path })));

server.tool("list_folders",
  "List every folder with its id, title, depth, and full path — useful before adding/moving.",
  {},
  async () => ok(await bridge.call("list_folders")));

server.tool("search_bookmarks",
  "Search bookmarks by text in title or URL.",
  { query: z.string().describe("text to match in title or URL") },
  async ({ query }) => ok(await bridge.call("search", { query })));

server.tool("stats",
  "Return counts of bookmarks and folders.",
  {},
  async () => ok(await bridge.call("stats")));

server.tool("ensure_folder_path",
  "Ensure a nested folder path exists (e.g. 'Bookmarks bar/Work/Reports'), creating missing levels. Returns the leaf folder. Top level must be 'Bookmarks bar', 'Other bookmarks', or 'Mobile bookmarks'.",
  { path: z.string().describe("slash-separated folder path") },
  async ({ path }) => ok(await bridge.call("ensure_path", { path: splitPath(path) })));

server.tool("add_bookmark",
  "Add a bookmark. Target a folder by folder_path (created if missing, default 'Bookmarks bar') or by parent_id. A folder_path's top level must be 'Bookmarks bar', 'Other bookmarks', or 'Mobile bookmarks'.",
  {
    title: z.string(),
    url: z.string(),
    folder_path: z.string().optional().describe("slash path whose top level is a permanent root, e.g. 'Bookmarks bar/Work'"),
    parent_id: z.string().optional()
  },
  async ({ title, url, folder_path, parent_id }) => {
    const pid = await resolveFolder(parent_id, folder_path);
    return ok(await bridge.call("create_bookmark", { parentId: pid, title, url }));
  });

server.tool("create_folder",
  "Create a folder under parent_path (created if missing, default 'Bookmarks bar') or parent_id. A parent_path's top level must be 'Bookmarks bar', 'Other bookmarks', or 'Mobile bookmarks'.",
  {
    name: z.string(),
    parent_path: z.string().optional(),
    parent_id: z.string().optional()
  },
  async ({ name, parent_path, parent_id }) => {
    const pid = await resolveFolder(parent_id, parent_path);
    return ok(await bridge.call("create_folder", { parentId: pid, title: name }));
  });

server.tool("update_bookmark",
  "Update a node's title and/or a bookmark's URL, by id.",
  { id: z.string(), title: z.string().optional(), url: z.string().optional() },
  async ({ id, title, url }) => {
    const out = {};
    if (title != null) out.renamed = await bridge.call("rename", { id, title });
    if (url != null) out.urlSet = await bridge.call("set_url", { id, url });
    return ok(out);
  });

server.tool("move_bookmark",
  "Move a node into a folder by to_path (created if missing) or to_parent_id. A to_path's top level must be 'Bookmarks bar', 'Other bookmarks', or 'Mobile bookmarks'.",
  { id: z.string(), to_path: z.string().optional(), to_parent_id: z.string().optional() },
  async ({ id, to_path, to_parent_id }) => {
    const pid = await resolveFolder(to_parent_id, to_path, null);
    if (!pid) throw new Error("provide to_path or to_parent_id");
    return ok(await bridge.call("move", { id, parentId: pid }));
  });

server.tool("remove_bookmark",
  "Remove a bookmark by id, or a folder and its contents (set recursive=true for folders).",
  { id: z.string(), recursive: z.boolean().optional() },
  async ({ id, recursive }) => { await bridge.call("remove", { id, recursive: !!recursive }); return ok({ removed: id, recursive: !!recursive }); });

server.tool("find_duplicates",
  "List groups of bookmarks that share the same URL.",
  {},
  async () => ok(await bridge.call("find_duplicates")));

server.tool("remove_duplicates",
  "Remove duplicate-URL bookmarks, keeping the first in each group. Use dry_run=true to preview without deleting.",
  { dry_run: z.boolean().optional() },
  async ({ dry_run }) => {
    const groups = await bridge.call("find_duplicates");
    const removals = [];
    for (const g of groups) for (const n of g.nodes.slice(1)) removals.push({ id: n.id, title: n.title, url: g.url, folder: n.folder });
    if (dry_run) return ok({ groups: groups.length, would_remove: removals.length, removals });
    let removed = 0;
    for (const r of removals) { await bridge.call("remove", { id: r.id, recursive: false }); removed++; }
    return ok({ groups: groups.length, removed, detail: removals });
  });

server.tool("export_json",
  "Export the whole bookmark tree as portable JSON. If file_path is given, write it server-side and return the path; otherwise return the JSON.",
  { file_path: z.string().optional() },
  async ({ file_path }) => {
    const data = await bridge.call("export", {});
    if (file_path) {
      try { await writeFile(file_path, JSON.stringify(data, null, 2)); }
      catch (e) { throw new Error(`Could not write export to ${file_path}: ${e.message}`); }
      return ok({ written: file_path });
    }
    return ok(data);
  });

server.tool("import_json",
  "Import a previously exported bookmark JSON file (see export_json) under a target folder. Recreates the tree; it does NOT deduplicate, so importing into a folder that already has the same bookmarks will create copies. Target via into_path (created if missing, default 'Other bookmarks') or into_parent_id. An into_path's top level must be 'Bookmarks bar', 'Other bookmarks', or 'Mobile bookmarks'.",
  { file_path: z.string(), into_path: z.string().optional(), into_parent_id: z.string().optional() },
  async ({ file_path, into_path, into_parent_id }) => {
    let data;
    try {
      data = JSON.parse(await readFile(file_path, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`No file found at ${file_path}. Pass the path to a JSON file produced by export_json.`);
      throw new Error(`Could not read or parse ${file_path}: ${e.message}`);
    }
    const pid = await resolveFolder(into_parent_id, into_path, "Other bookmarks");
    const created = await bridge.call("import", { parentId: pid, data });
    return ok({ imported_into: pid, created });
  });

server.tool("apply_moves",
  "Apply a catalogue plan TSV (columns: id, proposed, current, via, title, url). Creates each target folder and moves the bookmark into it. dry_run=true previews counts without changing anything. delete_junk=true also removes rows whose proposed folder is 'DELETE?'. Each proposed folder path's top level must be 'Bookmarks bar', 'Other bookmarks', or 'Mobile bookmarks' (except the literal 'DELETE?' when delete_junk is used).",
  { file_path: z.string().optional(), dry_run: z.boolean().optional(), delete_junk: z.boolean().optional() },
  async ({ file_path, dry_run, delete_junk }) => {
    const path = file_path || PLAN_DEFAULT;
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`No plan file found at ${path}. apply_moves reads a TSV with columns: id, proposed, current, via, title, url. Pass file_path, or set BOOKMARK_PLAN_FILE, then retry.`);
      }
      throw new Error(`Could not read plan file ${path}: ${e.message}`);
    }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) {
      throw new Error(`Plan file ${path} has no data rows. Expected a header line followed by TSV rows (id, proposed, current, via, title, url).`);
    }
    lines.shift(); // header
    const folderId = new Map();
    let moved = 0, deleted = 0, skipped = 0;
    const errors = [];
    for (const line of lines) {
      const [id, proposed] = line.split("\t");
      try {
        if (proposed === "DELETE?") {
          if (delete_junk) { if (!dry_run) await bridge.call("remove", { id, recursive: false }); deleted++; }
          else skipped++;
          continue;
        }
        if (!folderId.has(proposed)) {
          const segments = splitPath(proposed);
          if (dry_run) {
            assertPermanentRoot(segments);
            folderId.set(proposed, "(dry)");
          } else {
            const f = await bridge.call("ensure_path", { path: segments });
            folderId.set(proposed, f.id);
          }
        }
        if (!dry_run) await bridge.call("move", { id, parentId: folderId.get(proposed) });
        moved++;
      } catch (e) { errors.push({ id, proposed, error: e.message }); }
    }
    return ok({ dry_run: !!dry_run, plan: path, moved, deleted, skipped,
                distinct_target_folders: folderId.size, errors: errors.length, error_detail: errors.slice(0, 25) });
  });

server.tool("remove_empty_folders",
  "Sweep the tree and delete folders that contain no bookmarks (bottom-up), e.g. folders left empty after a re-catalogue. Skips the permanent roots. dry_run=true lists them without deleting.",
  { dry_run: z.boolean().optional() },
  async ({ dry_run }) => {
    const [root] = await bridge.call("get_tree");
    const removed = [];
    const gone = new Set(); // ids already listed (and, on apply, deleted)
    async function visit(node, isPermanent) {
      for (const ch of (node.children || []).filter(c => !c.url)) await visit(ch, false);
      if (!isPermanent) {
        const fresh = (await bridge.call("get_tree"))[0];
        const found = findById(fresh, node.id);
        // Live apply deletes empty children before this re-read, so the parent
        // looks empty. dry_run never calls remove, so get_tree still shows those
        // children — treat already-listed empty ids as gone so the cascade matches.
        const remaining = found
          ? (found.children || []).filter(c => !gone.has(c.id))
          : [];
        if (found && remaining.length === 0) {
          removed.push({ id: node.id, title: node.title });
          gone.add(node.id);
          if (!dry_run) await bridge.call("remove", { id: node.id, recursive: true });
        }
      }
    }
    function findById(n, id) {
      if (n.id === id) return n;
      for (const c of (n.children || [])) { const r = findById(c, id); if (r) return r; }
      return null;
    }
    for (const perm of (root.children || [])) await visit(perm, true);
    return ok({ dry_run: !!dry_run, removed_count: removed.length, removed });
  });

// Wrapped in an async IIFE so the bundle can target CommonJS (no top-level await).
(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] chrome-bookmarks server ready (stdio)");
})();
