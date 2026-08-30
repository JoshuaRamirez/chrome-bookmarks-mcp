// Robustness test: apply_moves against a missing plan file must return a clear,
// actionable message (not a raw ENOENT). Dry-run over the sample plan still
// reports the happy-path counts. Dry-run over a temp TSV with a non-root
// destination (an empty path, or a substring false-positive like Sidebar)
// must fail those rows, not count them as moved. The handler never calls
// the bridge in these cases, so no browser. Live ensurePath (extension/bridge.js)
// is loaded in-process against a mock chrome.bookmarks tree and must reject
// the same allowlist misses — including a first segment that equals a
// localized root title — so dry_run and live stay on the same rule.
//
// Run: node test/apply-moves.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const MISSING = join(__dirname, "..", "does-not-exist", "plan.tsv");
const SAMPLE = join(__dirname, "..", "examples", "sample-plan.tsv");

const tmp = await mkdtemp(join(tmpdir(), "apply-moves-"));
const BOGUS = join(tmp, "bogus-plan.tsv");
await writeFile(BOGUS, [
  "id\tproposed\tcurrent\tvia\ttitle\turl",
  "1\tWork/Projects\tBookmarks bar\ttitle-match\tBogus top level\thttps://example.com/a",
  "2\t///\tBookmarks bar\ttitle-match\tEmpty path\thttps://example.com/b",
  "3\tDELETE?\tOther bookmarks\tdead-link\tJunk\thttp://dead.example",
  "4\tbar/Dev\tBookmarks bar\ttitle-match\tAlias still ok\thttps://example.com/d",
  "5\tSidebar/Dev\tBookmarks bar\ttitle-match\tFalse-positive bar\thttps://example.com/e",
  "6\tMother/Kids\tBookmarks bar\ttitle-match\tFalse-positive other\thttps://example.com/f",
  "7\tAutomobile/Cars\tBookmarks bar\ttitle-match\tFalse-positive mobile\thttps://example.com/g",
  "8\tconstructor/Dev\tBookmarks bar\ttitle-match\tPrototype key\thttps://example.com/h",
].join("\n") + "\n");

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
// dry_run over the sample plan touches no bridge — parsing + counting only.
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "apply_moves", arguments: { file_path: SAMPLE, dry_run: true } } }) + "\n");
// dry_run over a bogus top-level + empty path must error those rows, not move them.
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "apply_moves", arguments: { file_path: BOGUS, dry_run: true } } }) + "\n");

await new Promise((r) => setTimeout(r, 2500));
try { child.kill("SIGTERM"); } catch { /* gone */ }
try { await rm(tmp, { recursive: true, force: true }); } catch { /* leftover tmp is fine */ }

const textOf = (resp) =>
  resp?.result?.content?.map((c) => c.text).join(" ") || resp?.error?.message || "";

let exitCode = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}${detail ? " — " + detail : ""}`); exitCode = 1; }
}

// 1. Missing plan file → clear, actionable error (not raw ENOENT).
check("apply_moves — missing plan file returns a clear, actionable error",
  /No plan file found/.test(textOf(responses.get(4))),
  textOf(responses.get(4)).slice(0, 160));

// 2. Dry-run over the sample plan reports the right counts without mutating.
let summary;
try { summary = JSON.parse(textOf(responses.get(5))); } catch { summary = null; }
check("apply_moves — dry-run over sample plan counts moves/skips/folders",
  summary && summary.dry_run === true && summary.moved === 3 && summary.skipped === 1 &&
  summary.distinct_target_folders === 2 && summary.errors === 0,
  JSON.stringify(summary));

// 3. Dry-run over a bogus plan: invalid top level + empty path are errors,
//    substring false-positives (Sidebar/Mother/Automobile) are errors too,
//    Object.prototype keys (constructor) are errors, DELETE? is still
//    skipped, and a bar/ alias is still a successful move.
let bogus;
try { bogus = JSON.parse(textOf(responses.get(6))); } catch { bogus = null; }
const details = bogus?.error_detail || [];
const msgs = details.map((e) => e.error || "");
check("apply_moves — dry-run rejects invalid destinations (not counted as moved)",
  bogus && bogus.dry_run === true && bogus.moved === 1 && bogus.skipped === 1 &&
  bogus.errors === 6 && bogus.distinct_target_folders === 1 &&
  msgs.some((m) => /top-level folder "Work" not found/.test(m)) &&
  msgs.some((m) => /top-level folder "Sidebar" not found/.test(m)) &&
  msgs.some((m) => /top-level folder "Mother" not found/.test(m)) &&
  msgs.some((m) => /top-level folder "Automobile" not found/.test(m)) &&
  msgs.some((m) => /top-level folder "constructor" not found/.test(m)) &&
  msgs.some((m) => m === "empty path"),
  JSON.stringify(bogus));

// 4. Live ensurePath uses the same allowlist as dry_run — no title-match
//    fallback. Localized root titles would have matched `r.title`; they must
//    still throw. Allowlisted aliases still resolve via folderType / id.
const LIVE_TREE = {
  id: "0", title: "", children: [
    { id: "1", title: "Barra de marcadores", folderType: "bookmarks-bar", parentId: "0", children: [] },
    { id: "2", title: "Otros marcadores", folderType: "other", parentId: "0", children: [] },
    { id: "3", title: "Marcadores del móvil", folderType: "mobile", parentId: "0", children: [] },
  ],
};
globalThis.chrome = {
  bookmarks: {
    async getTree() { return [LIVE_TREE]; },
  },
};
vm.runInThisContext(
  readFileSync(join(__dirname, "..", "extension", "bridge.js"), "utf8") +
  "\nglobalThis.ensurePath = ensurePath;\n"
);

const notFound = (seg) =>
  `top-level folder "${seg}" not found; use "Bookmarks bar", "Other bookmarks", or "Mobile bookmarks"`;

async function ensureRejects(name, segments, expected) {
  let err = "";
  try { await globalThis.ensurePath(segments); }
  catch (e) { err = e.message; }
  check(name, err === expected, err || "(succeeded)");
}

const bar = await globalThis.ensurePath(["Bookmarks bar"]);
check("ensurePath — allowlisted 'Bookmarks bar' resolves via folderType/id (not title)",
  bar && bar.id === "1",
  JSON.stringify(bar));
const viaBar = await globalThis.ensurePath(["bar"]);
check("ensurePath — short alias 'bar' still hits Bookmarks bar",
  viaBar && viaBar.id === "1",
  JSON.stringify(viaBar));
const viaOther = await globalThis.ensurePath(["other"]);
check("ensurePath — short alias 'other' still hits Other bookmarks",
  viaOther && viaOther.id === "2",
  JSON.stringify(viaOther));

await ensureRejects("ensurePath — localized title that would title-match is rejected",
  ["Barra de marcadores"], notFound("Barra de marcadores"));
await ensureRejects("ensurePath — live rejects Work (same as dry_run)",
  ["Work", "Projects"], notFound("Work"));
await ensureRejects("ensurePath — live rejects Sidebar (same as dry_run)",
  ["Sidebar", "Dev"], notFound("Sidebar"));
await ensureRejects("ensurePath — live rejects Mother (same as dry_run)",
  ["Mother", "Kids"], notFound("Mother"));
await ensureRejects("ensurePath — live rejects Automobile (same as dry_run)",
  ["Automobile", "Cars"], notFound("Automobile"));
await ensureRejects("ensurePath — live rejects constructor (same as dry_run)",
  ["constructor", "Dev"], notFound("constructor"));

console.log(exitCode ? "APPLY-MOVES TEST FAILED" : "APPLY-MOVES TEST PASSED");
process.exit(exitCode);
