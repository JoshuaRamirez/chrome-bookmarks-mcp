// Robustness test: apply_moves against a missing plan file must return a clear,
// actionable message (not a raw ENOENT). The handler reads the plan before it
// touches the bridge, so this needs no browser.
//
// Run: node test/apply-moves.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const MISSING = join(__dirname, "..", "does-not-exist", "plan.tsv");

const child = spawn("node", [BUNDLE], {
  env: { ...process.env, BOOKMARK_BRIDGE_PORT: "8795" },
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

child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "applymoves", version: "0" } } }) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "apply_moves", arguments: { file_path: MISSING, dry_run: true } } }) + "\n");

await new Promise((r) => setTimeout(r, 2500));
try { child.kill("SIGTERM"); } catch { /* gone */ }

// A thrown tool handler surfaces either as an error result (isError + content)
// or a JSON-RPC error; accept either and inspect the message text.
const resp = responses.get(4);
const text =
  resp?.result?.content?.map((c) => c.text).join(" ") ||
  resp?.error?.message ||
  "";

let exitCode = 0;
if (/No plan file found/.test(text)) {
  console.log("✓ apply_moves — missing plan file returns a clear, actionable error");
} else {
  console.error(`✗ apply_moves — expected a 'No plan file found' message, got: ${text.slice(0, 160)}`);
  exitCode = 1;
}

console.log(exitCode ? "APPLY-MOVES TEST FAILED" : "APPLY-MOVES TEST PASSED");
process.exit(exitCode);
