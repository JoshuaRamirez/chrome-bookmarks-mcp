// Extension bridge: dials the local MCP server's WebSocket and executes
// bookmark operations on request. Runs in the service worker; uses the shared
// BookmarkStore (lib/bookmarks.js, imported first by background.js).

const BRIDGE_URL = "ws://127.0.0.1:8765";
let _ws = null;

function bridgeConnected() {
  return _ws && _ws.readyState === WebSocket.OPEN;
}

function bridgeConnect() {
  if (bridgeConnected() || (_ws && _ws.readyState === WebSocket.CONNECTING)) return;
  let ws;
  console.log("[bridge] connecting to", BRIDGE_URL);
  try { ws = new WebSocket(BRIDGE_URL); } catch (e) { console.log("[bridge] construct failed:", e && e.message); return; }
  _ws = ws;
  ws.onopen = () => { console.log("[bridge] OPEN"); try { ws.send(JSON.stringify({ hello: "bookmark-manager" })); } catch (_) {} };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.method === "ping") return; // keepalive only
    const { id, method, params } = msg;
    try {
      const result = await bridgeDispatch(method, params || {});
      ws.send(JSON.stringify({ id, ok: true, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id, ok: false, error: (e && e.message) || String(e) }));
    }
  };
  ws.onclose = () => { console.log("[bridge] CLOSE — retry in 3s"); _ws = null; setTimeout(bridgeConnect, 3000); };
  ws.onerror = (e) => { console.log("[bridge] ERROR", (e && e.message) || ""); try { ws.close(); } catch (_) {} };
}

async function bridgeDispatch(method, p) {
  switch (method) {
    case "get_tree":        return chrome.bookmarks.getTree();
    case "list_bookmarks":  return BookmarkStore.listBookmarks(p.folderPath);
    case "list_folders":    return BookmarkStore.listFolders();
    case "search":          return BookmarkStore.searchWithPaths(p.query);
    case "stats":           return BookmarkStore.stats();
    case "create_folder":   return BookmarkStore.createFolder(p.parentId, p.title);
    case "create_bookmark": return BookmarkStore.createBookmark(p.parentId, p.title, p.url);
    case "rename":          return BookmarkStore.rename(p.id, p.title);
    case "set_url":         return BookmarkStore.setUrl(p.id, p.url);
    case "move":            return BookmarkStore.move(p.id, p.parentId, p.index);
    case "remove":          return BookmarkStore.remove(p.id, !!p.recursive);
    case "find_duplicates": return BookmarkStore.findDuplicates();
    case "export":          return BookmarkStore.exportTree(p.rootId);
    case "import":          return BookmarkStore.importInto(p.parentId, p.data);
    case "ensure_path":     return ensurePath(p.path || []);
    default: throw new Error("unknown method: " + method);
  }
}

// Allowlist of first-segment aliases for Chrome's three permanent roots.
// Exact match after lowercasing and collapsing whitespace — keep in lockstep
// with permanentRootAlias in src/server.js. Substring tests falsely accept
// Sidebar / Mother / Automobile (they contain bar / other / mobile).
const PERMANENT_ROOT_ALIASES = new Map([
  ["bar", ["bookmarks-bar", "1"]],
  ["toolbar", ["bookmarks-bar", "1"]],
  ["bookmarks bar", ["bookmarks-bar", "1"]],
  ["bookmarks-bar", ["bookmarks-bar", "1"]],
  ["other", ["other", "2"]],
  ["other bookmarks", ["other", "2"]],
  ["mobile", ["mobile", "3"]],
  ["mobile bookmarks", ["mobile", "3"]],
]);

function permanentRootAlias(segment) {
  const key = String(segment || "").toLowerCase().replace(/\s+/g, " ").trim();
  return PERMANENT_ROOT_ALIASES.get(key) || null;
}

// Resolve (creating missing levels) a folder path. First segment must name a
// permanent root: Bookmarks bar / Other bookmarks / Mobile bookmarks.
async function ensurePath(segments) {
  if (!segments.length) throw new Error("empty path");
  const [root] = await chrome.bookmarks.getTree();
  const roots = root.children || [];
  const first = segments[0].toLowerCase();
  const alias = permanentRootAlias(segments[0]);
  let cur = alias
    ? (roots.find(r => r.folderType === alias[0]) || roots.find(r => r.id === alias[1]))
    : roots.find(r => (r.title || "").toLowerCase() === first);
  if (!cur) throw new Error(`top-level folder "${segments[0]}" not found; use "Bookmarks bar", "Other bookmarks", or "Mobile bookmarks"`);
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const kids = await chrome.bookmarks.getChildren(cur.id);
    cur = kids.find(k => !k.url && (k.title || "").toLowerCase() === seg.toLowerCase())
       || await chrome.bookmarks.create({ parentId: cur.id, title: seg });
  }
  return { id: cur.id, title: cur.title, parentId: cur.parentId };
}
