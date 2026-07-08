// Robustness test: when the bridge port is already taken, the server must not
// masquerade as merely "extension not connected" — bookmarks_status should
// surface the real EADDRINUSE cause so the user knows to free the port or change
// BOOKMARK_BRIDGE_PORT. Verifies the diagnostic path added in the bridge.
//
// Run: node test/port-conflict.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PORT = "8794"; // dedicated to this test

function spawnServer() {
  return spawn("node", [BUNDLE], {
    env: { ...process.env, BOOKMARK_BRIDGE_PORT: PORT },
    stdio: ["pipe", "pipe", "ignore"],
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Blocker holds the port first; the server-under-test then collides with it.
const blocker = spawnServer();
await delay(700);
const server = spawnServer();

const responses = new Map();
let buf = "";
server.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* stderr bleed */ }
  }
});

server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "portclash", version: "0" } } }) + "\n");
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bookmarks_status", arguments: {} } }) + "\n");

await delay(1500);

let exitCode = 0;
const text = responses.get(3)?.result?.content?.[0]?.text || "";
let status;
try { status = JSON.parse(text); } catch { status = null; }

if (status && status.connected === false && status.listening === false && /EADDRINUSE/.test(status.message || "")) {
  console.log("✓ port-conflict — bookmarks_status reports EADDRINUSE instead of a misleading 'not connected'");
} else {
  console.error(`✗ port-conflict — expected an EADDRINUSE diagnostic, got: ${text.slice(0, 160)}`);
  exitCode = 1;
}

for (const p of [blocker, server]) { try { p.kill("SIGTERM"); } catch { /* gone */ } }
console.log(exitCode ? "PORT-CONFLICT TEST FAILED" : "PORT-CONFLICT TEST PASSED");
process.exit(exitCode);
