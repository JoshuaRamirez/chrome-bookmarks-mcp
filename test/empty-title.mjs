// Contract test: create_folder must reject a provided name that trims to
// empty ("", whitespace-only) with "empty folder name", and update_bookmark
// must reject a provided title the same way with "empty title". Both throw
// before any bridge call, so a disconnected Chrome bridge must not turn
// that input into "not connected".
// Omitting title on update_bookmark stays allowed (url-only still reaches
// the bridge; omitting both title and url still returns an empty result).
// A title with significant edge spaces (" Dev") is not empty and still
// reaches the bridge. No Chrome required.
//
// Run: node test/empty-title.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PORT = "8802";

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

const send = (id, name, args) => {
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }) + "\n");
};

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "empty-title", version: "0" } },
}) + "\n");

send(2, "create_folder", { name: "" });
send(3, "create_folder", { name: "   " });
send(4, "create_folder", { name: "Dev" });
send(5, "create_folder", { name: " Dev" });
send(6, "update_bookmark", { id: "1", title: "" });
send(7, "update_bookmark", { id: "1", title: "   " });
send(8, "update_bookmark", { id: "1", title: "", url: "https://example.test" });
send(9, "update_bookmark", { id: "1", url: "https://example.test" });
send(10, "update_bookmark", { id: "1" });
send(11, "update_bookmark", { id: "1", title: " Dev" });

await new Promise((r) => setTimeout(r, 2500));
try { child.kill("SIGTERM"); } catch { /* gone */ }

const textOf = (resp) =>
  resp?.result?.content?.map((c) => c.text).join(" ") || resp?.error?.message || "";

let exitCode = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}${detail ? " — " + detail : ""}`); exitCode = 1; }
}

const emptyName = (id) => {
  const text = textOf(responses.get(id));
  return /empty folder name/.test(text) && !/not connected|empty path|empty title/.test(text);
};

const emptyTitle = (id) => {
  const text = textOf(responses.get(id));
  return /empty title/.test(text) && !/not connected|empty folder name|empty path/.test(text);
};

const reachedBridge = (id) => {
  const text = textOf(responses.get(id));
  return /not connected/.test(text) && !/empty folder name|empty title|empty path/.test(text);
};

check("create_folder — name \"\" throws empty folder name (not not-connected)",
  emptyName(2), textOf(responses.get(2)).slice(0, 200));
check("create_folder — name whitespace throws empty folder name (trim regression)",
  emptyName(3), textOf(responses.get(3)).slice(0, 200));
check("create_folder — name \"Dev\" still reaches the bridge (not empty folder name)",
  reachedBridge(4), textOf(responses.get(4)).slice(0, 200));
check("create_folder — name \" Dev\" still reaches the bridge (edge space kept)",
  reachedBridge(5), textOf(responses.get(5)).slice(0, 200));

check("update_bookmark — title \"\" throws empty title (not not-connected)",
  emptyTitle(6), textOf(responses.get(6)).slice(0, 200));
check("update_bookmark — title whitespace throws empty title (trim regression)",
  emptyTitle(7), textOf(responses.get(7)).slice(0, 200));
check("update_bookmark — title \"\" with url still throws empty title (before the bridge)",
  emptyTitle(8), textOf(responses.get(8)).slice(0, 200));
check("update_bookmark — omitted title with url still reaches the bridge",
  reachedBridge(9), textOf(responses.get(9)).slice(0, 200));
check("update_bookmark — omitted title and url still returns without empty title",
  textOf(responses.get(10)).trim() === "{}" &&
    !/empty title|not connected|empty folder name/.test(textOf(responses.get(10))),
  textOf(responses.get(10)).slice(0, 200));
check("update_bookmark — title \" Dev\" still reaches the bridge (edge space kept)",
  reachedBridge(11), textOf(responses.get(11)).slice(0, 200));

console.log(exitCode ? "EMPTY-TITLE TEST FAILED" : "EMPTY-TITLE TEST PASSED");
process.exit(exitCode);
