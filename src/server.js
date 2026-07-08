#!/usr/bin/env node
// chrome-bookmarks-mcp — an MCP server exposing Chrome bookmark management.
// It runs a localhost WebSocket bridge that the Bookmark Manager extension
// connects to; each MCP tool forwards an operation to the extension, which
// executes it via chrome.bookmarks (so every change syncs durably).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.js";

// Fallback location for an apply_moves plan when no explicit file_path is given.
// Overridable via BOOKMARK_PLAN_FILE; otherwise a stable per-user path.
const PLAN_DEFAULT =
  process.env.BOOKMARK_PLAN_FILE ||
  join(homedir() || tmpdir(), ".chrome-bookmarks-mcp", "proposed-moves.tsv");

const PORT = Number(process.env.BOOKMARK_BRIDGE_PORT || 8765);
const bridge = new Bridge(PORT);
bridge.start();

const server = new McpServer({ name: "chrome-bookmarks", version: "1.0.2" });

// Wrap a value as MCP text content.
const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }]
});
const splitPath = (p) => String(p || "").split("/").map(s => s.trim()).filter(Boolean);

// Resolve a folder target to an id: prefer parent_id, else ensure the path.
async function resolveFolder(parent_id, path, fallback = "Bookmarks bar") {
  if (parent_id) return parent_id;
  const folder = await bridge.call("ensure_path", { path: splitPath(path || fallback) });
  return folder.id;
}

server.tool("bookmarks_status",
  "Report whether the Chrome extension bridge is connected and on what port. When disconnected, returns step-by-step setup guidance — call this first if any other tool fails to reach the browser.",
  {},
  async () => {
    if (bridge.connected()) {
      return ok({ connected: true, port: PORT, message: "Extension bridge connected — all bookmark tools are ready." });
    }
    return ok({
      connected: false,
      port: PORT,
      message: "Extension bridge NOT connected. Bookmark tools cannot reach the browser until the companion Chrome extension is loaded and Chrome is running.",
      fix: [
        "Make sure Google Chrome is open.",
        "Open chrome://extensions and enable Developer mode (top-right).",
        "Click 'Load unpacked' and select this plugin's extension/ folder.",
        `The extension dials ws://127.0.0.1:${PORT}. If you set BOOKMARK_BRIDGE_PORT to a non-default port, update BRIDGE_URL in extension/bridge.js to match.`,
        "Once loaded, re-run bookmarks_status to confirm."
      ]
    });
  });

server.tool("list_bookmarks",
  "Return the full bookmark tree (all folders and bookmarks, nested).",
  {},
  async () => ok(await bridge.call("get_tree")));

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
  "Add a bookmark. Target a folder by folder_path (created if missing, default 'Bookmarks bar') or by parent_id.",
  {
    title: z.string(),
    url: z.string(),
    folder_path: z.string().optional().describe("e.g. 'Bookmarks bar/AspenESS'"),
    parent_id: z.string().optional()
  },
  async ({ title, url, folder_path, parent_id }) => {
    const pid = await resolveFolder(parent_id, folder_path);
    return ok(await bridge.call("create_bookmark", { parentId: pid, title, url }));
  });

server.tool("create_folder",
  "Create a folder under parent_path (created if missing, default 'Bookmarks bar') or parent_id.",
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
  "Move a node into a folder by to_path (created if missing) or to_parent_id.",
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
    if (file_path) { await writeFile(file_path, JSON.stringify(data, null, 2)); return ok({ written: file_path }); }
    return ok(data);
  });

server.tool("apply_moves",
  "Apply a catalogue plan TSV (columns: id, proposed, current, via, title, url). Creates each target folder and moves the bookmark into it. dry_run=true previews counts without changing anything. delete_junk=true also removes rows whose proposed folder is 'DELETE?'.",
  { file_path: z.string().optional(), dry_run: z.boolean().optional(), delete_junk: z.boolean().optional() },
  async ({ file_path, dry_run, delete_junk }) => {
    const path = file_path || PLAN_DEFAULT;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
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
          if (dry_run) folderId.set(proposed, "(dry)");
          else {
            const f = await bridge.call("ensure_path", { path: proposed.split("/").map(s => s.trim()).filter(Boolean) });
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
    async function visit(node, isPermanent) {
      for (const ch of (node.children || []).filter(c => !c.url)) await visit(ch, false);
      if (!isPermanent) {
        const fresh = (await bridge.call("get_tree"))[0];
        const found = findById(fresh, node.id);
        if (found && (!found.children || found.children.length === 0)) {
          removed.push({ id: node.id, title: node.title });
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
