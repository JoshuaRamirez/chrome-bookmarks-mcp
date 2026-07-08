// BookmarkStore — a thin, well-defined wrapper over the chrome.bookmarks API.
// Centralizes traversal, folder enumeration, de-duplication, and portable
// export/import so both the popup and the manager page share one vocabulary.
// Loaded as a classic script (importScripts in the worker, <script> in pages),
// so it exposes the class on globalThis by name.

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
  // returns only parentId, so we resolve every folder's path once and join.
  static async searchWithPaths(query) {
    const hits = await chrome.bookmarks.search(query);
    if (!hits.length) return [];
    const folderPath = new Map(); // folder id -> "A / B / C" (including itself)
    await BookmarkStore.walk((node, _p, _d, path) => {
      if (!node.url) folderPath.set(node.id, path.concat(node.title).filter(Boolean).join(" / "));
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

  // Depth-first walk over the real tree. cb(node, parent, depth, pathTitles[]).
  static async walk(cb) {
    const [root] = await chrome.bookmarks.getTree();
    const rec = (node, parent, depth, path) => {
      cb(node, parent, depth, path);
      (node.children || []).forEach(ch =>
        rec(ch, node, depth + 1, path.concat(node.title || "")));
    };
    (root.children || []).forEach(ch => rec(ch, root, 0, []));
    return root;
  }

  // All folders as { id, title, depth, path } — for pickers and move targets.
  static async listFolders() {
    const out = [];
    await BookmarkStore.walk((node, _p, depth, path) => {
      if (!node.url) {
        out.push({
          id: node.id, title: node.title, depth,
          path: path.concat(node.title).filter(Boolean).join(" / ")
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

  // Groups of bookmarks sharing a URL (length > 1), with folder context.
  static async findDuplicates() {
    const byUrl = new Map();
    await BookmarkStore.walk((node, _p, _d, path) => {
      if (!node.url) return;
      const arr = byUrl.get(node.url) || [];
      arr.push({ id: node.id, title: node.title, folder: path.filter(Boolean).join(" / ") || "(root)" });
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
  static async importInto(parentId, data) {
    let created = 0;
    const rec = async (parent, node) => {
      if (node.url) {
        await chrome.bookmarks.create({ parentId: parent, title: node.title || node.url, url: node.url });
        created++;
      } else {
        let pid = parent;
        if (node.title) {
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
