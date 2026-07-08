// Smoke test: boot the bundled MCP server over stdio and assert it speaks the
// protocol, exposes every expected tool, and returns actionable setup guidance
// when the browser bridge is not connected. No Chrome required — the bridge
// simply reports "not connected", which is itself a case worth verifying.
//
// Run: npm test   (exit code 0 = pass, non-zero = fail)

import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PORT = "8791"; // off-default so we never collide with a real instance

const EXPECTED_TOOLS = [
  "bookmarks_status", "list_bookmarks", "list_folders", "search_bookmarks",
  "stats", "ensure_folder_path", "add_bookmark", "create_folder",
  "update_bookmark", "move_bookmark", "remove_bookmark", "find_duplicates",
  "remove_duplicates", "export_json", "apply_moves", "remove_empty_folders",
];

const REQUESTS = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bookmarks_status", arguments: {} } },
];

function fail(msg) { console.error(`✗ ${msg}`); process.exitCode = 1; }
function pass(msg) { console.log(`✓ ${msg}`); }

const child = spawn("node", [BUNDLE], {
  env: { ...process.env, BOOKMARK_BRIDGE_PORT: PORT },
  stdio: ["pipe", "pipe", "inherit"],
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
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch { /* ignore non-JSON stderr bleed */ }
  }
});

// Send all requests, then give the server a moment to answer.
for (const r of REQUESTS) child.stdin.write(JSON.stringify(r) + "\n");

const timeout = setTimeout(() => { finish(); }, 4000);

async function finish() {
  clearTimeout(timeout);
  try { child.kill("SIGTERM"); } catch { /* already gone */ }

  // 1. initialize
  const init = responses.get(1);
  if (init?.result?.serverInfo?.name === "chrome-bookmarks") pass("initialize handshake");
  else fail(`initialize handshake — got ${JSON.stringify(init)}`);

  // 2. tools/list contains every expected tool
  const listed = (responses.get(2)?.result?.tools || []).map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((t) => !listed.includes(t));
  const extra = listed.filter((t) => !EXPECTED_TOOLS.includes(t));
  if (!missing.length && !extra.length) pass(`tools/list — all ${EXPECTED_TOOLS.length} tools present`);
  else fail(`tools/list — missing: [${missing}] extra: [${extra}]`);

  // 3. bookmarks_status returns actionable guidance while disconnected
  const statusText = responses.get(3)?.result?.content?.[0]?.text || "";
  let status;
  try { status = JSON.parse(statusText); } catch { status = null; }
  if (status && status.connected === false && Array.isArray(status.fix) && status.fix.length >= 3) {
    pass("bookmarks_status — returns setup guidance when disconnected");
  } else {
    fail(`bookmarks_status — expected connected:false with a fix[] list, got ${statusText.slice(0, 120)}`);
  }

  console.log(process.exitCode ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST PASSED");
}

// Also finish if the child dies unexpectedly.
once(child, "exit").then(() => { if (!timeout._destroyed) finish(); });
