// BookmarkStore — a thin, well-defined wrapper over the chrome.bookmarks API.
// Centralizes traversal, folder enumeration, de-duplication, and portable
// export/import so both the popup and the manager page share one vocabulary.
// Loaded as a classic script (importScripts in the worker, <script> in pages),
// so it exposes the class on globalThis by name.

// Path codec — keep in lockstep with src/folder-path.js.
// Escape \ then / in each title so "A / B / C" paths round-trip when a title
// contains / or \. splitPath is the inverse: split on unescaped /, unescape.
function escapePathSegment(title) {
  return String(title ?? "").replace(/\\/g, "\\\\").replace(/\//g, "\\/");
}
function joinFolderPath(titles) {
  return (titles || []).filter(Boolean).map(escapePathSegment).join(" / ");
}
function splitPath(p) {
  const s = String(p || "");
  const out = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === "/" || next === "\\") {
        buf += next;
        i++;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === "/") {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf.trim());
  return out.filter(Boolean);
}

// Allowlist of first-segment aliases for Chrome's three permanent roots.
// Exact match after lowercasing and collapsing whitespace — keep in lockstep
// with permanentRootAlias in src/server.js. Substring tests falsely accept
// Sidebar / Mother / Automobile (they contain bar / other / mobile).
// ensurePath (extension/bridge.js) calls BookmarkStore.permanentRootAlias so
// list and write paths share this Map.
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

// First-segment alias → the live permanent root's title. Chrome localizes
// those titles (German "Lesezeichenleiste", and so on), so an English display
// string is not a valid rewrite. The title is not an identity: a local root
// and a syncing root share it (both "Bookmarks bar"). Callers that scope a
// path use the node from findPermanentRoot (its id), not this string.
// Lookup matches ensurePath via BookmarkStore.permanentRootForAlias.
async function resolvePermanentRootTitle(segment) {
  const node = await findPermanentRoot(segment);
  if (!BookmarkStore.permanentRootAlias(segment)) return null;
  const title = node && String(node.title || "").trim();
  return title || null;
}

// Live permanent root for a first path segment, using ensurePath's lookup:
// alias via permanentRootForAlias, otherwise a case-insensitive title among
// root.children. Null when nothing matches — including substring lookalikes
// such as Sidebar / Mother / Automobile.
async function findPermanentRoot(segment) {
  const [root] = await chrome.bookmarks.getTree();
  const roots = root.children || [];
  const alias = BookmarkStore.permanentRootAlias(segment);
  if (alias) return BookmarkStore.permanentRootForAlias(roots, alias);
  const first = String(segment || "").toLowerCase();
  return roots.find((r) => (r.title || "").toLowerCase() === first) || null;
}

class BookmarkStore {
  // Conventional permanent ids; treated as non-editable roots.
  static PERMANENT_PARENT = "0"; // children of the tree root are the permanent folders

  static async getTree()          { return chrome.bookmarks.getTree(); }
  static async getChildren(id)    { return chrome.bookmarks.getChildren(id); }
  static async getSubTree(id)     { return chrome.bookmarks.getSubTree(id); }
  static async createFolder(parentId, title)        { return chrome.bookmarks.create({ parentId, title }); }
  static async createBookmark(parentId, title, url) { return chrome.bookmarks.create({ parentId, title, url }); }
  static async rename(id, title)  { return chrome.bookmarks.update(id, { title }); }
  static async setUrl(id, url)    { return chrome.bookmarks.update(id, { url }); }
  static async move(id, parentId, index) {
    return chrome.bookmarks.move(id, index == null ? { parentId } : { parentId, index });
  }
  static async remove(id, recursive) {
    return recursive ? chrome.bookmarks.removeTree(id) : chrome.bookmarks.remove(id);
  }
  static async search(query)      { return chrome.bookmarks.search(query); }

  // Like search(), but each hit carries its containing folder path — the context
  // callers actually want ("where is this bookmark?"). chrome.bookmarks.search
  // returns folders (no url) as well as bookmarks; we keep only url hits — the
  // same filter listBookmarks / findDuplicates / the manager UI already apply.
  // Search returns only parentId, so we resolve every folder's path once and join.
  static async searchWithPaths(query) {
    const hits = (await chrome.bookmarks.search(query)).filter(h => h.url);
    if (!hits.length) return [];
    const folderPath = new Map(); // folder id -> escaped "A / B / C" (including itself)
    await BookmarkStore.walk((node, _p, _d, path) => {
      if (!node.url) folderPath.set(node.id, joinFolderPath(path.concat(node.title)));
    });
    return hits.map(h => ({
      id: h.id,
      title: h.title,
      url: h.url,
      folder: folderPath.get(h.parentId) || "(root)"
    }));
  }

  static isPermanent(node) {
    return node.id === "0" || node.parentId === BookmarkStore.PERMANENT_PARENT;
  }

  // [folderType, id] for a permanent-root alias, or null. Map lookup only —
  // never a substring test. Same key normalization as src/server.js.
  static permanentRootAlias(segment) {
    const key = String(segment || "").toLowerCase().replace(/\s+/g, " ").trim();
    return PERMANENT_ROOT_ALIASES.get(key) || null;
  }

  // Live permanent root for an alias [folderType, id]. Chrome 134+ can return
  // two roots with the same folderType and different `syncing` values
  // (account vs local). This package's contract is synced bookmarks, so
  // prefer folderType + syncing === true. Otherwise keep the historical
  // lookup: first folderType match, else the conventional permanent id.
  // Shared by ensurePath, resolvePermanentRootTitle, and findPermanentRoot.
  static permanentRootForAlias(roots, alias) {
    const list = roots || [];
    return list.find((r) => r.folderType === alias[0] && r.syncing === true)
      || list.find((r) => r.folderType === alias[0])
      || list.find((r) => r.id === alias[1])
      || null;
  }

  // Depth-first walk over the real tree. cb(node, parent, depth, pathTitles[]).
  // rootId, when set, limits the walk to that direct child of the tree root
  // (a permanent root selected by id). A same-titled sibling is not visited.
  static async walk(cb, rootId) {
    const [root] = await chrome.bookmarks.getTree();
    const rec = (node, parent, depth, path) => {
      cb(node, parent, depth, path);
      (node.children || []).forEach(ch =>
        rec(ch, node, depth + 1, path.concat(node.title || "")));
    };
    let children = root.children || [];
    if (rootId != null) children = children.filter((ch) => ch.id === rootId);
    children.forEach(ch => rec(ch, root, 0, []));
    return root;
  }

  // All folders as { id, title, depth, path } — for pickers and move targets.
  static async listFolders() {
    const out = [];
    await BookmarkStore.walk((node, _p, depth, path) => {
      if (!node.url) {
        out.push({
          id: node.id, title: node.title, depth,
          path: joinFolderPath(path.concat(node.title))
        });
      }
    });
    return out;
  }

  static async stats() {
    let folders = 0, urls = 0;
    await BookmarkStore.walk(n => { n.url ? urls++ : folders++; });
    return { folders, urls };
  }

  // Flat list of bookmarks as { id, title, url, folder }. Optionally scoped to a
  // folder path (e.g. "Bookmarks bar / Dev"), matching that folder and anything
  // beneath it. Flat + scoped keeps results bounded — the whole nested tree is
  // rarely what a caller wants and can be very large.
  // folder_path compare is case-insensitive on real title segments (splitPath
  // unescapes; no join→re-split) so "bookmarks bar/dev" and USAGE
  // "Other Bookmarks" match Chrome titles, and a title like "CI/CD" is one
  // segment. Emitted `folder` keeps Chrome's casing with / and \ escaped so
  // the string round-trips through splitPath. The first segment, when it is a
  // permanent-root alias, selects one live root via findPermanentRoot
  // (permanentRootForAlias — same node as ensurePath) and the walk is limited
  // to that root's id. Later segments stay literal titles under that subtree.
  // Two roots that share a title (both "Bookmarks bar", local and syncing)
  // therefore do not both match "bar/Dev". A non-alias first segment still
  // matches by case-insensitive title across the tree, including a localized
  // title passed literally. A first segment that is neither an alias nor a
  // live root title (same lookup as ensurePath) throws
  // top-level folder "…" not found — not a silent empty list. A resolved
  // root whose child is missing or empty still returns [].
  // A provided folderPath that normalizes to empty ("/", "///", whitespace)
  // throws "empty path" — same as ensurePath / apply_moves. Omit (undefined
  // / null) still lists everything.
  static async listBookmarks(folderPath) {
    let prefixSegs = null;
    let scopeRootId = null;
    if (folderPath != null) {
      const segs = splitPath(folderPath);
      if (!segs.length) throw new Error("empty path");
      const selected = await findPermanentRoot(segs[0]);
      if (!selected) {
        throw new Error(`top-level folder "${segs[0]}" not found; use "Bookmarks bar", "Other bookmarks", or "Mobile bookmarks"`);
      }
      // Alias → one root id. Rewriting the segment to the shared title would
      // also match the other permanent root. Non-alias titles stay a
      // whole-tree title prefix, which is what a literal localized name does.
      if (BookmarkStore.permanentRootAlias(segs[0])) {
        scopeRootId = selected.id;
        prefixSegs = segs.slice(1).map((s) => s.toLowerCase());
      } else {
        prefixSegs = segs.map((s) => s.toLowerCase());
      }
    }
    const out = [];
    await BookmarkStore.walk((node, _p, _d, path) => {
      if (!node.url) return;
      const titles = path.filter(Boolean);
      const folder = joinFolderPath(titles) || "(root)";
      if (prefixSegs) {
        const comparable = scopeRootId != null ? path.slice(1) : path;
        const key = comparable.filter(Boolean).map((s) => String(s).trim().toLowerCase());
        if (key.length < prefixSegs.length || !prefixSegs.every((s, i) => s === key[i])) return;
      }
      out.push({ id: node.id, title: node.title, url: node.url, folder });
    }, scopeRootId);
    return out;
  }

  // Groups of bookmarks sharing a URL (length > 1), with folder context.
  static async findDuplicates() {
    const byUrl = new Map();
    await BookmarkStore.walk((node, _p, _d, path) => {
      if (!node.url) return;
      const arr = byUrl.get(node.url) || [];
      arr.push({ id: node.id, title: node.title, folder: joinFolderPath(path.filter(Boolean)) || "(root)" });
      byUrl.set(node.url, arr);
    });
    return [...byUrl.entries()]
      .filter(([, a]) => a.length > 1)
      .map(([url, nodes]) => ({ url, nodes }));
  }

  // Portable JSON for a subtree (default: whole tree). Shape: {title?,url?,children?}.
  static async exportTree(rootId) {
    const [node] = rootId
      ? await chrome.bookmarks.getSubTree(rootId)
      : await chrome.bookmarks.getTree();
    const strip = (n) => {
      const o = {};
      if (n.title != null && n.title !== "") o.title = n.title;
      if (n.url) o.url = n.url;
      if (n.children) o.children = n.children.map(strip);
      return o;
    };
    return strip(node);
  }

  // Recreate portable JSON under a target folder. Returns count of nodes made.
  // A folder title that trims to empty ("", "   ", tabs) is not a path segment
  // splitPath can re-target. Skip that level and flatten children under the
  // current parent, the same as today's falsy "". Significant edge spaces
  // (" Dev") still create a folder, with the original title. Bookmark nodes
  // (url present) keep the title they were given.
  static async importInto(parentId, data) {
    let created = 0;
    const rec = async (parent, node) => {
      if (node.url) {
        await chrome.bookmarks.create({ parentId: parent, title: node.title || node.url, url: node.url });
        created++;
      } else {
        let pid = parent;
        // Non-strings keep the old truthy check. Strings must survive trim so
        // whitespace-only titles are not created.
        const title = typeof node.title === "string" ? node.title.trim() : node.title;
        if (title) {
          const f = await chrome.bookmarks.create({ parentId: parent, title: node.title });
          pid = f.id; created++;
        }
        for (const ch of (node.children || [])) await rec(pid, ch);
      }
    };
    if (data.children && !data.url) {
      for (const ch of data.children) await rec(parentId, ch); // unwrap rootless container
    } else {
      await rec(parentId, data);
    }
    return created;
  }
}

globalThis.BookmarkStore = BookmarkStore;
