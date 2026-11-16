// Run bridge operations from the command line, without the MCP layer: start the
// bridge, wait for the extension, run each call in order, print the results as
// one JSON array on stdout, exit. Stops at the first failing call (exit 2).
// Run while the real MCP server is NOT running (they share the port).
//
//   node src/call.mjs list_tabs
//   node src/call.mjs group_tabs '{"tabIds":[12],"groupTitle":"CAP"}' list_tab_groups
//
// CALL_WAIT_MS            how long to wait for the extension (default 90000)
// CALL_MIN_EXTENSION      wait until the extension reports at least this version
//                         (e.g. 1.1.0) — for use right after editing the extension

import { Bridge } from "./bridge.js";

const args = process.argv.slice(2);
const calls = [];
for (let i = 0; i < args.length; i++) {
  const method = args[i];
  let params = {};
  if (args[i + 1] && /^\s*\{/.test(args[i + 1])) params = JSON.parse(args[++i]);
  calls.push({ method, params });
}
if (!calls.length) { console.error("usage: node src/call.mjs <method> ['{json params}'] [<method> …]"); process.exit(64); }

const PORT = Number(process.env.BOOKMARK_BRIDGE_PORT || 8765);
const WAIT_MS = Number(process.env.CALL_WAIT_MS || 90000);
const MIN = process.env.CALL_MIN_EXTENSION || "";
const bridge = new Bridge(PORT);
bridge.start();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const older = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

const deadline = Date.now() + WAIT_MS;
let ready = false, seen = "nothing connected";
while (!ready && Date.now() < deadline) {
  if (!bridge.connected()) { await sleep(500); continue; }
  if (!MIN) { ready = true; break; }
  try {
    const { version } = await bridge.call("version", {}, 4000);
    seen = `extension ${version}`;
    if (!older(version, MIN)) { ready = true; break; }
  } catch (e) { seen = `an extension too old to report its version (${e.message})`; }
  await sleep(2000);
}
if (!ready) { console.error(`[call] gave up after ${Math.round(WAIT_MS / 1000)}s: ${seen}${MIN ? `; wanted ${MIN} or newer` : ""}`); process.exit(1); }

const out = [];
let code = 0;
for (const c of calls) {
  try { out.push({ method: c.method, ok: true, result: await bridge.call(c.method, c.params) }); }
  catch (e) { out.push({ method: c.method, ok: false, error: e.message }); code = 2; break; }
}
console.log(JSON.stringify(out, null, 2));
process.exit(code);
