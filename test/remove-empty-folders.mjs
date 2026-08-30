// remove_empty_folders dry_run must list the same cascade live apply would
// delete: a parent that only contains empty folders becomes empty once those
// children are gone. dry_run never calls remove, so it must treat already-
// listed empty ids as gone instead of trusting a fresh get_tree. A fake
// WebSocket "extension" supplies the tree — no Chrome required.
//
// Run: node test/remove-empty-folders.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PORT = "8796";

// root(0)
//   Bookmarks bar(1)                         permanent — skip even if emptied
//     EmptyParent(10)
//       EmptyChild(100)                      empty folder
//     HasBookmark(11)
//       "Keep" https://keep.example (110)
//     MixedParent(12)
//       EmptyLeaf(120)                       empty folder
//       "Also keep" https://keep.example/b (121)
//   Other bookmarks(2)                       permanent + empty — still skip
function makeTree() {
  return {
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks bar", parentId: "0", children: [
        { id: "10", title: "EmptyParent", parentId: "1", children: [
          { id: "100", title: "EmptyChild", parentId: "10", children: [] },
        ] },
        { id: "11", title: "HasBookmark", parentId: "1", children: [
          { id: "110", title: "Keep", url: "https://keep.example", parentId: "11" },
        ] },
        { id: "12", title: "MixedParent", parentId: "1", children: [
          { id: "120", title: "EmptyLeaf", parentId: "12", children: [] },
          { id: "121", title: "Also keep", url: "https://keep.example/b", parentId: "12" },
        ] },
      ] },
      { id: "2", title: "Other bookmarks", parentId: "0", children: [] },
    ],
  };
}

function findById(n, id) {
  if (n.id === id) return n;
  for (const c of n.children || []) { const r = findById(c, id); if (r) return r; }
  return null;
}

function detach(node, id) {
  if (!node.children) return false;
  const i = node.children.findIndex((c) => c.id === id);
  if (i >= 0) { node.children.splice(i, 1); return true; }
  return node.children.some((c) => detach(c, id));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn("node", [BUNDLE], {
  env: { ...process.env, BOOKMARK_BRIDGE_PORT: PORT },
  stdio: ["pipe", "pipe", "ignore"],
});

const responses = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* stderr bleed */ }
  }
});

function waitFor(id, ms = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - start > ms) return reject(new Error(`timeout waiting for MCP id ${id}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function connectFake(onCall) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { try { sock.close(); } catch { /* */ } reject(new Error("open timeout")); }, 400);
        sock.once("open", () => { clearTimeout(t); resolve(sock); });
        sock.once("error", (e) => { clearTimeout(t); reject(e); });
      });
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.method === "ping" || msg.id == null) return;
        const { id, method, params } = msg;
        try {
          const result = onCall(method, params || {});
          ws.send(JSON.stringify({ id, ok: true, result }));
        } catch (e) {
          ws.send(JSON.stringify({ id, ok: false, error: e.message || String(e) }));
        }
      });
      ws.send(JSON.stringify({ hello: "remove-empty-folders-test" }));
      return ws;
    } catch {
      await delay(80);
    }
  }
  throw new Error("could not connect fake extension to the bridge");
}

let exitCode = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}${detail ? " — " + detail : ""}`); exitCode = 1; }
}

const textOf = (resp) =>
  resp?.result?.content?.map((c) => c.text).join(" ") || resp?.error?.message || "";

try {
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "emptyfolders", version: "0" } },
  }) + "\n");
  await waitFor(1);

  // --- dry_run: tree is never mutated; remove must not be called ----------
  const dryTree = makeTree();
  const dryRemoves = [];
  const dryWs = await connectFake((method, params) => {
    if (method === "get_tree") return [dryTree];
    if (method === "remove") { dryRemoves.push(params); return {}; }
    throw new Error("unexpected method: " + method);
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 10, method: "tools/call",
    params: { name: "remove_empty_folders", arguments: { dry_run: true } },
  }) + "\n");
  let dry;
  try { dry = JSON.parse(textOf(await waitFor(10))); } catch { dry = null; }
  try { dryWs.close(); } catch { /* */ }

  const dryIds = (dry?.removed || []).map((r) => r.id);
  check("dry_run — lists empty child and nested empty parent",
    dry && dry.dry_run === true && dryIds.includes("100") && dryIds.includes("10"),
    JSON.stringify(dry));
  check("dry_run — lists empty leaf under a mixed parent",
    dryIds.includes("120"),
    JSON.stringify(dry));
  check("dry_run — does not list folder with a bookmark, mixed parent, or permanent roots",
    !dryIds.includes("11") && !dryIds.includes("12") && !dryIds.includes("1") && !dryIds.includes("2") && !dryIds.includes("0"),
    JSON.stringify(dry));
  check("dry_run — removed_count matches listed folders",
    dry && dry.removed_count === dryIds.length && dryIds.length === 3,
    JSON.stringify(dry));
  check("dry_run — never calls remove",
    dryRemoves.length === 0,
    JSON.stringify(dryRemoves));

  // --- live apply: same cascade, actually delete, keep bookmarks ----------
  const liveTree = makeTree();
  const liveRemoves = [];
  const liveWs = await connectFake((method, params) => {
    if (method === "get_tree") return [liveTree];
    if (method === "remove") {
      liveRemoves.push(params);
      detach(liveTree, params.id);
      return {};
    }
    throw new Error("unexpected method: " + method);
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 20, method: "tools/call",
    params: { name: "remove_empty_folders", arguments: { dry_run: false } },
  }) + "\n");
  let live;
  try { live = JSON.parse(textOf(await waitFor(20))); } catch { live = null; }
  try { liveWs.close(); } catch { /* */ }

  const liveIds = (live?.removed || []).map((r) => r.id);
  const removedIds = liveRemoves.map((p) => p.id);
  check("live — deletes empty child and nested empty parent",
    live && live.dry_run === false && liveIds.includes("100") && liveIds.includes("10") &&
    removedIds.includes("100") && removedIds.includes("10"),
    JSON.stringify({ live, liveRemoves }));
  check("live — deletes empty leaf; leaves bookmark folder, mixed parent, permanent roots",
    liveIds.includes("120") && removedIds.includes("120") &&
    !liveIds.includes("11") && !liveIds.includes("12") && !liveIds.includes("1") && !liveIds.includes("2") &&
    findById(liveTree, "11") && findById(liveTree, "110") && findById(liveTree, "12") && findById(liveTree, "121") &&
    findById(liveTree, "1") && findById(liveTree, "2") &&
    !findById(liveTree, "10") && !findById(liveTree, "100") && !findById(liveTree, "120"),
    JSON.stringify({ live, treeGone: { ten: !!findById(liveTree, "10"), keep: !!findById(liveTree, "11") } }));
  check("live — dry_run lists the same ids live deletes",
    dryIds.slice().sort().join(",") === liveIds.slice().sort().join(","),
    `dry=${dryIds} live=${liveIds}`);
} catch (e) {
  console.error(`✗ remove_empty_folders — ${e.message}`);
  exitCode = 1;
}

try { child.kill("SIGTERM"); } catch { /* gone */ }
console.log(exitCode ? "REMOVE-EMPTY-FOLDERS TEST FAILED" : "REMOVE-EMPTY-FOLDERS TEST PASSED");
process.exit(exitCode);
