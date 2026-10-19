// Shared-bridge test: one copy of the server per machine, run by shared-mcp's
// gateway, owns the bridge port; every session connects through a thin
// shared-mcp bridge and never binds the port itself. Two sessions read at once,
// writes stay off, and stopping the gateway leaves no copy holding the port.
// A stand-in extension answers on a free port, so no Chrome is needed.
//
// Run: node test/shared-sessions.mjs   (invoked by `npm test`)
// Needs shared-mcp (SHARED_MCP_KIT, default ~/Developer/shared-mcp/shared_mcp.py).

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "bundle.cjs");
const KIT = process.env.SHARED_MCP_KIT || join(homedir(), "Developer", "shared-mcp", "shared_mcp.py");
const NAME = "cbm-shared-test";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(KIT)) {
  console.log(`- shared-sessions — SKIPPED: shared-mcp not found at ${KIT} (set SHARED_MCP_KIT)`);
  process.exit(0);
}

const PORT = await new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => res(String(port))); });
});

let exitCode = 0;
function fail(msg) { console.error(`✗ ${msg}`); exitCode = 1; }
function pass(msg) { console.log(`✓ ${msg}`); }
const kit = (...args) => { try { return execFileSync("python3", [KIT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { return e.stdout || ""; } };

// The stand-in extension: dials the bridge port like extension/bridge.js does,
// redials 300 ms after a close, and answers read ops. A write op reaching it is a failure.
const ext = { calls: [], writes: [], connects: 0, stopped: false };
function dial() {
  if (ext.stopped) return;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("open", () => { ext.connects++; ws.send(JSON.stringify({ hello: "bookmark-manager" })); });
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id == null) return;
    ext.calls.push(m.method);
    if (m.method === "stats") ws.send(JSON.stringify({ id: m.id, ok: true, result: { bookmarks: 3, folders: 2 } }));
    else if (m.method === "list_folders") ws.send(JSON.stringify({ id: m.id, ok: true, result: [{ id: "1", path: "Bookmarks bar" }, { id: "2", path: "Bookmarks bar/Desk" }] }));
    else { ext.writes.push(m.method); ws.send(JSON.stringify({ id: m.id, ok: false, error: "stand-in extension: not a read" })); }
  });
  ws.on("error", () => {});
  ws.on("close", () => setTimeout(dial, 300));
}

// A session: shared-mcp's connect bridge, exactly as the user-scope registration runs it.
function session(label) {
  const p = spawn("python3", [KIT, "connect", "--name", NAME, "--env", "BOOKMARK_BRIDGE_PORT", "--env", "BOOKMARK_WRITES", "--env", "BOOKMARK_BRIDGE_RETRY_MS", "--", process.execPath, BUNDLE], {
    env: { ...process.env, BOOKMARK_BRIDGE_PORT: PORT, BOOKMARK_WRITES: "off", BOOKMARK_BRIDGE_RETRY_MS: "300" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const out = new Map(); let buf = ""; let seq = 100;
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.id != null) out.set(m.id, m); } catch { /* not JSON */ } }
  });
  const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
  const rpc = async (method, params, ms = 60000) => {
    const id = ++seq; send({ jsonrpc: "2.0", id, method, params });
    for (const end = Date.now() + ms; Date.now() < end; await delay(50)) if (out.has(id)) return out.get(id);
    throw new Error(`${label}: no answer to ${method}`);
  };
  const tool = async (name, args = {}, ms) => { const r = await rpc("tools/call", { name, arguments: args }, ms); const t = r.result?.content?.[0]?.text; try { return JSON.parse(t); } catch { return t ?? r.error; } };
  const init = async () => { const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: label, version: "0" } }, 120000); send({ jsonrpc: "2.0", method: "notifications/initialized" }); return r.result?.serverInfo?.name; };
  return { p, init, tool, label };
}
async function untilConnected(s, ms = 30000) {
  let st;
  for (const end = Date.now() + ms; Date.now() < end; await delay(300)) {
    try { st = await s.tool("bookmarks_status", {}, ms); } catch (e) { st = { error: e.message }; }
    if (st?.connected) return st;
  }
  return st;
}
const holderPid = () => { try { return execFileSync("lsof", ["-nP", "-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

kit("stop", "--name", NAME);
let a, b;
try {
  dial();
  a = session("session-a"); b = session("session-b");
  const [na, nb] = await Promise.all([a.init(), b.init()]);
  if (na === "chrome-bookmarks" && nb === "chrome-bookmarks") pass("two sessions initialise through shared-mcp");
  else fail(`initialise — got ${na} / ${nb}`);

  const [sa, sb] = await Promise.all([untilConnected(a), untilConnected(b)]);
  if (sa?.connected && sb?.connected) pass("both sessions see the bridge connected");
  else fail(`bookmarks_status — got ${JSON.stringify(sa).slice(0, 140)} / ${JSON.stringify(sb).slice(0, 140)}`);
  if (sa?.writes === "off" && sb?.writes === "off") pass("writes are off in the shared copy");
  else fail(`writes — got ${sa?.writes} / ${sb?.writes}`);

  const holders = holderPid();
  if (holders.length === 1) pass(`one process holds the bridge port (pid ${holders[0]})`);
  else fail(`expected one holder of port ${PORT}, got [${holders}]`);

  const [ra, rb] = await Promise.all([a.tool("stats"), b.tool("stats")]);
  const [fa, fb] = await Promise.all([a.tool("list_folders"), b.tool("list_folders")]);
  if (ra?.bookmarks === 3 && rb?.bookmarks === 3 && fa?.length === 2 && fb?.length === 2) pass("both sessions read bookmarks at once");
  else fail(`reads — got ${JSON.stringify([ra, rb, fa?.length, fb?.length])}`);

  const w = await a.tool("add_bookmark", { title: "t", url: "https://example.com" });
  if (w?.writes === "off" && ext.writes.length === 0) pass("a write through a session is report-only and never reaches the extension");
  else fail(`write — got ${JSON.stringify(w).slice(0, 140)}; extension saw ${ext.writes}`);

} catch (e) {
  fail(`shared-sessions — ${e.message}`);
} finally {
  ext.stopped = true;
  for (const s of [a, b]) { try { s?.p.kill("SIGTERM"); } catch { /* gone */ } }
  kit("stop", "--name", NAME);
  await delay(500);
  for (let i = 0; i < 20 && holderPid().length; i++) await delay(250);
  if (holderPid().length === 0) pass("cleanup — test gateway stopped, its copy exited, port released");
  else fail(`cleanup — port ${PORT} still held by [${holderPid()}]`);
}
console.log(exitCode ? "SHARED-SESSIONS TEST FAILED" : "SHARED-SESSIONS TEST PASSED");
process.exit(exitCode);
