// Contract test: write tools that go through resolveFolder must reject a
// provided empty folder path ("") with "empty path" — they must not treat
// "" as omit and silently land on the default root. Omitting the path still
// attempts the fallback (bridge not connected here). move_bookmark with both
// destination args omitted still says to provide to_path / to_parent_id.
// No Chrome required — empty path throws before ensure_path.
//
// Run: node test/resolve-folder.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PORT = "8798";

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
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "resolve-folder", version: "0" } },
}) + "\n");

send(2, "add_bookmark", { title: "X", url: "https://example.test", folder_path: "" });
send(3, "create_folder", { name: "X", parent_path: "" });
send(4, "move_bookmark", { id: "1", to_path: "" });
send(5, "move_bookmark", { id: "1" });
send(6, "add_bookmark", { title: "X", url: "https://example.test" });

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
  return /empty path/.test(text) && !/Bookmarks bar|Other bookmarks|not connected/.test(text);
};

check("add_bookmark — folder_path \"\" throws empty path (not default root)",
  emptyPath(2), textOf(responses.get(2)).slice(0, 160));
check("create_folder — parent_path \"\" throws empty path (not default root)",
  emptyPath(3), textOf(responses.get(3)).slice(0, 160));
check("move_bookmark — to_path \"\" throws empty path (not provide-to_path)",
  emptyPath(4), textOf(responses.get(4)).slice(0, 160));
check("move_bookmark — omit both still asks for to_path or to_parent_id",
  /provide to_path or to_parent_id/.test(textOf(responses.get(5))) &&
    !/empty path/.test(textOf(responses.get(5))),
  textOf(responses.get(5)).slice(0, 160));
check("add_bookmark — omitted folder_path still uses fallback (bridge, not empty path)",
  /not connected/.test(textOf(responses.get(6))) &&
    !/empty path/.test(textOf(responses.get(6))),
  textOf(responses.get(6)).slice(0, 160));

console.log(exitCode ? "RESOLVE-FOLDER TEST FAILED" : "RESOLVE-FOLDER TEST PASSED");
process.exit(exitCode);
