// Diagnostic: start the bridge, wait for the extension to connect, run a few
// read-only calls, print results to stderr, then exit. Verifies the
// extension<->server link without the MCP layer. Run while the real MCP server
// is NOT running (they share the port).
//
//   node probe.mjs

import { Bridge } from "./bridge.js";

const PORT = Number(process.env.BOOKMARK_BRIDGE_PORT || 8765);
const bridge = new Bridge(PORT);
bridge.start();

const WAIT_MS = Number(process.env.PROBE_WAIT_MS || 90000);
console.error(`[probe] waiting up to ${Math.round(WAIT_MS / 1000)}s for the extension to connect on :${PORT} …`);
console.error("[probe] (reload the extension at chrome://extensions; it reconnects within ~60s anyway)");

const deadline = Date.now() + WAIT_MS;
while (!bridge.connected() && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 500));
}
if (!bridge.connected()) {
  console.error("[probe] FAILED: extension never connected.");
  process.exit(1);
}

try {
  const s = await bridge.call("stats");
  console.error("[probe] stats:", JSON.stringify(s));
  const folders = await bridge.call("list_folders");
  console.error(`[probe] folders: ${folders.length}`);
  const dups = await bridge.call("find_duplicates");
  console.error(`[probe] duplicate-URL groups: ${dups.length}`);
  console.error("[probe] OK — bridge round-trip works.");
  process.exit(0);
} catch (e) {
  console.error("[probe] ERROR:", e.message);
  process.exit(2);
}
