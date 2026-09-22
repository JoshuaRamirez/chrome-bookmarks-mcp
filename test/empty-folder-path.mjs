// Contract test: ensure_folder_path and list_bookmarks must reject a provided
// empty folder path ("", whitespace-only, "/") with "empty path" before any
// bridge call. They must not wait for Chrome and return "not connected".
// Omitting folder_path on list_bookmarks still lists everything (bridge not
// connected here). No Chrome required.
//
// Run: node test/empty-folder-path.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PORT = "8800";

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
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "empty-folder-path", version: "0" } },
}) + "\n");

send(2, "ensure_folder_path", { path: "" });
send(3, "ensure_folder_path", { path: "   " });
send(4, "ensure_folder_path", { path: "/" });
send(5, "list_bookmarks", { folder_path: "" });
send(6, "list_bookmarks", { folder_path: "   " });
send(7, "list_bookmarks", { folder_path: "/" });
send(8, "list_bookmarks", {});

await new Promise((r) => setTimeout(r, 2500));
try { child.kill("SIGTERM"); } catch { /* gone */ }

const textOf = (resp) =>
  resp?.result?.content?.map((c) => c.text).join(" ") || resp?.error?.message || "";

let exitCode = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}${detail ? " — " + detail : ""}`); exitCode = 1; }
}

const emptyPath = (id) => {
  const text = textOf(responses.get(id));
  return /empty path/.test(text) && !/not connected/.test(text);
};

check("ensure_folder_path — path \"\" throws empty path (not not-connected)",
  emptyPath(2), textOf(responses.get(2)).slice(0, 200));
check("ensure_folder_path — path whitespace throws empty path (trim regression)",
  emptyPath(3), textOf(responses.get(3)).slice(0, 200));
check("ensure_folder_path — path \"/\" throws empty path (not not-connected)",
  emptyPath(4), textOf(responses.get(4)).slice(0, 200));
check("list_bookmarks — folder_path \"\" throws empty path (not not-connected)",
  emptyPath(5), textOf(responses.get(5)).slice(0, 200));
check("list_bookmarks — folder_path whitespace throws empty path (trim regression)",
  emptyPath(6), textOf(responses.get(6)).slice(0, 200));
check("list_bookmarks — folder_path \"/\" throws empty path (not not-connected)",
  emptyPath(7), textOf(responses.get(7)).slice(0, 200));
check("list_bookmarks — omitted folder_path still reaches the bridge (not empty path)",
  /not connected/.test(textOf(responses.get(8))) &&
    !/empty path/.test(textOf(responses.get(8))),
  textOf(responses.get(8)).slice(0, 200));

console.log(exitCode ? "EMPTY-FOLDER-PATH TEST FAILED" : "EMPTY-FOLDER-PATH TEST PASSED");
process.exit(exitCode);
