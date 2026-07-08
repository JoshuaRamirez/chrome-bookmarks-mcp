// Bridge: a localhost WebSocket server that the Chrome extension dials into.
// The MCP server calls bridge.call(method, params) to execute a bookmark
// operation inside the extension's chrome.bookmarks context and await the
// result. All logging goes to stderr (stdout is reserved for the MCP protocol).

import { WebSocketServer } from "ws";

export class Bridge {
  constructor(port = 8765, log = (...a) => console.error(...a)) {
    this.port = port;
    this.log = log;
    this.sock = null;        // the single active extension socket
    this.seq = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
  }

  start() {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
    this.wss.on("connection", (ws) => {
      this.sock = ws;
      this.log("[bridge] extension connected");
      ws.on("message", (buf) => this._onMessage(buf));
      ws.on("close", () => { if (this.sock === ws) this.sock = null; this.log("[bridge] extension disconnected"); });
      ws.on("error", (e) => this.log("[bridge] socket error:", e.message));
    });
    this.wss.on("error", (e) => this.log("[bridge] server error:", e.message));
    // Periodic ping keeps the extension's MV3 service worker alive (WebSocket
    // traffic resets its idle-shutdown timer).
    this._ka = setInterval(() => {
      if (this.connected()) { try { this.sock.send(JSON.stringify({ method: "ping" })); } catch {} }
    }, 20000);
    this.log(`[bridge] listening on ws://127.0.0.1:${this.port}`);
  }

  _onMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.hello) { this.log(`[bridge] hello from ${msg.hello}`); return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error || "bridge error"));
    }
  }

  connected() { return !!(this.sock && this.sock.readyState === 1); }

  call(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.connected()) {
        reject(new Error("Chrome bridge not connected — open Chrome with the Bookmark Manager extension loaded."));
        return;
      }
      const id = this.seq++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge timeout waiting for "${method}"`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.sock.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
}
