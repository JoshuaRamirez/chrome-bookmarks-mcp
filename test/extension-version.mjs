// Stale-extension detection: the companion extension reports the plugin/package
// version on hello. bookmarks_status, when connected, must surface
// server_version and extension_version, and warn when they differ or the
// extension reports nothing (older builds that Chrome kept after a
// marketplace upgrade). No Chrome required — a fake WebSocket stands in.
//
// Run: node test/extension-version.mjs   (invoked by `npm test`)

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUNDLE = join(ROOT, "dist", "bundle.cjs");
const PORT = "8801";

const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const pluginVersion = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
const bridgeSrc = readFileSync(join(ROOT, "extension", "bridge.js"), "utf8");
const pluginConst = bridgeSrc.match(/const PLUGIN_VERSION = "([^"]+)";/);

let exitCode = 0;
function check(name, cond, detail) {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}${detail ? " — " + detail : ""}`);
    exitCode = 1;
  }
}

check(
  "PLUGIN_VERSION matches package.json",
  pluginConst && pluginConst[1] === pkgVersion,
  `bridge=${pluginConst && pluginConst[1]} package=${pkgVersion}`,
);
check(
  "PLUGIN_VERSION matches plugin.json",
  pluginConst && pluginConst[1] === pluginVersion,
  `bridge=${pluginConst && pluginConst[1]} plugin=${pluginVersion}`,
);
check(
  "hello sends PLUGIN_VERSION",
  /hello:\s*"bookmark-manager",\s*version:\s*PLUGIN_VERSION/.test(bridgeSrc),
);

const child = spawn("node", [BUNDLE], {
  env: { ...process.env, BOOKMARK_BRIDGE_PORT: PORT },
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = new Map();
let buf = "";
let logs = "";
let nextId = 1;

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
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(id, ms = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - start > ms) return reject(new Error(`timeout waiting for MCP id ${id}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForLog(from, needle, ms = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (logs.slice(from).includes(needle)) return resolve();
      if (Date.now() - start > ms) {
        return reject(new Error(`timeout waiting for log ${JSON.stringify(needle)}\n${logs.slice(from)}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function statusOf(resp) {
  const text = resp?.result?.content?.[0]?.text || "";
  try { return JSON.parse(text); } catch { return null; }
}

async function callStatus() {
  const id = ++nextId;
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "bookmarks_status", arguments: {} },
  }) + "\n");
  return statusOf(await waitFor(id));
}

async function connectFake(hello) {
  const deadline = Date.now() + 5000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const t = setTimeout(() => { try { sock.close(); } catch { /* */ } reject(new Error("open timeout")); }, 400);
        sock.once("open", () => { clearTimeout(t); resolve(sock); });
        sock.once("error", (e) => { clearTimeout(t); reject(e); });
      });
      ws.on("message", () => { /* ignore pings */ });
      const needle = hello.version
        ? `hello from ${hello.hello} ${hello.version}`
        : `hello from ${hello.hello} (no version)`;
      const from = logs.length;
      ws.send(JSON.stringify(hello));
      await waitForLog(from, needle);
      return ws;
    } catch (e) {
      lastErr = e;
      if (String(e && e.message || e).startsWith("timeout waiting for log")) throw e;
      await delay(80);
    }
  }
  throw lastErr || new Error("could not connect fake extension");
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    try { ws.close(); } catch { resolve(); }
    setTimeout(resolve, 500);
  });
}

try {
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "extver", version: "0" } },
  }) + "\n");
  await waitFor(1);

  // Older installs send hello with no version. Chrome still has that unpacked
  // copy after a marketplace upgrade.
  const stale = await connectFake({ hello: "bookmark-manager" });
  const missing = await callStatus();
  const fixText = (missing?.fix || []).join("\n");
  check("missing version — connected", missing?.connected === true, JSON.stringify(missing));
  check("missing version — server_version", missing?.server_version === pkgVersion, missing?.server_version);
  check("missing version — extension_version null", missing?.extension_version == null, JSON.stringify(missing?.extension_version));
  check("missing version — warning", typeof missing?.warning === "string" && missing.warning.length > 0);
  check(
    "missing version — fix points at chrome://extensions and extension_dir",
    /chrome:\/\/extensions/.test(fixText) &&
      /Load unpacked/.test(fixText) &&
      missing?.extension_dir &&
      fixText.includes(missing.extension_dir) &&
      existsSync(join(missing.extension_dir, "manifest.json")) &&
      /bookmarks_status/.test(fixText),
    fixText,
  );
  await closeWs(stale);

  const drifted = await connectFake({ hello: "bookmark-manager", version: "1.1.16" });
  const mismatch = await callStatus();
  check("mismatch — extension_version", mismatch?.extension_version === "1.1.16", mismatch?.extension_version);
  check("mismatch — server_version", mismatch?.server_version === pkgVersion);
  check("mismatch — warning names both versions", /1\.1\.16/.test(mismatch?.warning || "") && mismatch.warning.includes(pkgVersion), mismatch?.warning);
  check("mismatch — fix reloads from extension_dir", (mismatch?.fix || []).join("\n").includes(mismatch?.extension_dir));
  await closeWs(drifted);

  const current = await connectFake({ hello: "bookmark-manager", version: pkgVersion });
  const ready = await callStatus();
  check("match — server_version", ready?.server_version === pkgVersion);
  check("match — extension_version", ready?.extension_version === pkgVersion, ready?.extension_version);
  check("match — no warning", ready?.warning == null && ready?.fix == null, JSON.stringify(ready));
  check("match — ready message", /all bookmark tools are ready/.test(ready?.message || ""), ready?.message);
  await closeWs(current);
} catch (e) {
  console.error(`✗ extension-version — ${e && e.message ? e.message : e}`);
  exitCode = 1;
} finally {
  try { child.kill("SIGTERM"); } catch { /* gone */ }
}

console.log(exitCode ? "EXTENSION-VERSION TEST FAILED" : "EXTENSION-VERSION TEST PASSED");
process.exit(exitCode);
