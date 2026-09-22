// Contract test: apply_moves and export_json must reject a provided empty
// file path ("") or whitespace-only ("   ") with "empty file path". They must
// not treat those as omit — apply_moves would silently read PLAN_DEFAULT, and
// export_json would silently return JSON in-band.
// Omitting file_path still uses the default: apply_moves reads
// BOOKMARK_PLAN_FILE (dry_run over the sample plan, no Chrome), and
// export_json attempts an in-band export (bridge not connected here).
// No Chrome required — empty file path throws before any read or bridge call.
//
// Run: node test/file-path.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const PLAN = join(__dirname, "..", "examples", "sample-plan.tsv");
const PORT = "8799";

const child = spawn("node", [BUNDLE], {
  env: {
    ...process.env,
    BOOKMARK_BRIDGE_PORT: PORT,
    BOOKMARK_PLAN_FILE: PLAN,
  },
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
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "file-path", version: "0" } },
}) + "\n");

send(2, "apply_moves", { file_path: "", dry_run: true });
send(3, "apply_moves", { file_path: "   ", dry_run: true });
send(4, "apply_moves", { dry_run: true });
send(5, "export_json", { file_path: "" });
send(6, "export_json", { file_path: "   " });
send(7, "export_json", {});

await new Promise((r) => setTimeout(r, 2500));
try { child.kill("SIGTERM"); } catch { /* gone */ }

const textOf = (resp) =>
  resp?.result?.content?.map((c) => c.text).join(" ") || resp?.error?.message || "";

let exitCode = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}${detail ? " — " + detail : ""}`); exitCode = 1; }
}

const emptyFile = (id) => {
  const text = textOf(responses.get(id));
  return /empty file path/.test(text) &&
    !/No plan file found|not connected|written/.test(text);
};

check("apply_moves — file_path \"\" throws empty file path (not default plan)",
  emptyFile(2), textOf(responses.get(2)).slice(0, 200));
check("apply_moves — file_path whitespace throws empty file path (trim regression)",
  emptyFile(3), textOf(responses.get(3)).slice(0, 200));

let omitted;
try { omitted = JSON.parse(textOf(responses.get(4))); } catch { omitted = null; }
check("apply_moves — omitted file_path still uses BOOKMARK_PLAN_FILE",
  omitted && omitted.dry_run === true && omitted.plan === PLAN && omitted.moved === 3 &&
    omitted.errors === 0 && !/empty file path/.test(textOf(responses.get(4))),
  textOf(responses.get(4)).slice(0, 200));

check("export_json — file_path \"\" throws empty file path (not in-band JSON)",
  emptyFile(5), textOf(responses.get(5)).slice(0, 200));
check("export_json — file_path whitespace throws empty file path (trim regression)",
  emptyFile(6), textOf(responses.get(6)).slice(0, 200));
check("export_json — omitted file_path still returns in-band (bridge, not empty file path)",
  /not connected/.test(textOf(responses.get(7))) &&
    !/empty file path/.test(textOf(responses.get(7))),
  textOf(responses.get(7)).slice(0, 200));

console.log(exitCode ? "FILE-PATH TEST FAILED" : "FILE-PATH TEST PASSED");
process.exit(exitCode);
