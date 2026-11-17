// Report-only test: with BOOKMARK_WRITES=off, every tool that would add, move,
// rename or delete answers with what it would do and sends nothing to Chrome,
// and bookmarks_status says writes are off. No Chrome required.
//
// Run: node test/writes-off.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PORT = await new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => res(String(port))); });
});

const WRITES = [
  ["ensure_folder_path", { path: "Bookmarks bar/T" }],
  ["add_bookmark", { title: "t", url: "https://example.com" }],
  ["create_folder", { name: "t" }],
  ["update_bookmark", { id: "1", title: "t" }],
  ["move_bookmark", { id: "1", to_parent_id: "2" }],
  ["remove_bookmark", { id: "1", recursive: true }],
  ["group_tabs", { tab_ids: [1], group_title: "T" }],
  ["ungroup_tabs", { tab_ids: [1] }],
  ["move_tabs", { tab_ids: [1], index: 0 }],
  ["update_tab_group", { group_id: 1, title: "T" }],
  ["move_tab_group", { group_id: 1 }],
  ["reload_extension", {}],
];

function fail(msg) { console.error(`✗ ${msg}`); process.exitCode = 1; }
function pass(msg) { console.log(`✓ ${msg}`); }

const child = spawn("node", [BUNDLE], {
  env: { ...process.env, BOOKMARK_BRIDGE_PORT: PORT, BOOKMARK_WRITES: "off" },
  stdio: ["pipe", "pipe", "ignore"],
});
const responses = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* not JSON */ }
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "writes-off", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bookmarks_status", arguments: {} } });
WRITES.forEach(([name, args], k) => send({ jsonrpc: "2.0", id: 10 + k, method: "tools/call", params: { name, arguments: args } }));

setTimeout(() => {
  child.kill("SIGTERM");
  const text = (id) => responses.get(id)?.result?.content?.[0]?.text || "";
  let status; try { status = JSON.parse(text(2)); } catch { status = null; }
  if (status?.writes === "off") pass("bookmarks_status — reports writes: off");
  else fail(`bookmarks_status — expected writes: off, got ${text(2).slice(0, 120)}`);
  WRITES.forEach(([name], k) => {
    let r; try { r = JSON.parse(text(10 + k)); } catch { r = null; }
    if (r?.writes === "off" && r?.tool === name && r?.would) pass(`${name} — report-only, nothing sent to Chrome`);
    else fail(`${name} — expected a report-only answer, got ${text(10 + k).slice(0, 160) || JSON.stringify(responses.get(10 + k)?.error)}`);
  });
  console.log(process.exitCode ? "\nWRITES-OFF TEST FAILED" : "\nWRITES-OFF TEST PASSED");
}, 2500);
