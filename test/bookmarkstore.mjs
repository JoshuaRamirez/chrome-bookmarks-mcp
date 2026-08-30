// Unit tests for BookmarkStore — the extension's core logic — run in Node
// against a mock chrome.bookmarks tree. The class only touches the `chrome`
// global, so we can exercise its pure traversal/dedupe/export/search behavior
// without a browser. This is the real coverage for the untested heart of the
// system.
//
// Run: node test/bookmarkstore.mjs   (invoked by `npm test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- mock tree ------------------------------------------------------------
// root(0)
//   Bookmarks bar(1)
//     Dev(10)
//       "MCP Spec"  https://modelcontextprotocol.io   (100)
//       "React"     https://react.dev                 (101)
//     "GitHub"      https://github.com                (102)
//   Other bookmarks(2)
//     News(20)
//       "HN"        https://news.ycombinator.com      (200)
//     "Dupe GH"     https://github.com                (201)  <- dup of 102
const TREE = {
  id: "0", title: "", children: [
    { id: "1", title: "Bookmarks bar", parentId: "0", children: [
      { id: "10", title: "Dev", parentId: "1", children: [
        { id: "100", title: "MCP Spec", url: "https://modelcontextprotocol.io", parentId: "10" },
        { id: "101", title: "React", url: "https://react.dev", parentId: "10" },
      ] },
      { id: "102", title: "GitHub", url: "https://github.com", parentId: "1" },
    ] },
    { id: "2", title: "Other bookmarks", parentId: "0", children: [
      { id: "20", title: "News", parentId: "2", children: [
        { id: "200", title: "HN", url: "https://news.ycombinator.com", parentId: "20" },
      ] },
      { id: "201", title: "Dupe GH", url: "https://github.com", parentId: "2" },
    ] },
  ],
};

function flatten(node, acc = []) {
  acc.push(node);
  (node.children || []).forEach((c) => flatten(c, acc));
  return acc;
}
const ALL = flatten(TREE);
const byId = (id) => ALL.find((n) => n.id === id);

globalThis.chrome = {
  bookmarks: {
    async getTree() { return [TREE]; },
    async getSubTree(id) { return [byId(id)]; },
    async getChildren(id) { return (byId(id).children || []).map((c) => c); },
    async search(query) {
      // Match chrome.bookmarks.search: title or URL, including folder nodes (no url).
      const q = String(query).toLowerCase();
      return ALL.filter((n) => {
        const titleHit = (n.title || "").toLowerCase().includes(q);
        const urlHit = n.url && n.url.toLowerCase().includes(q);
        return titleHit || urlHit;
      }).map((n) => ({ id: n.id, title: n.title, url: n.url, parentId: n.parentId }));
    },
    // Minimal create: record the node and hand back a fresh id (importInto needs
    // the returned id to nest children under a newly-created folder).
    _created: [],
    async create(node) {
      const id = "new" + (this._created.length + 1);
      const made = { id, ...node };
      this._created.push(made);
      return made;
    },
  },
};

// Load the classic-script class into this context.
vm.runInThisContext(readFileSync(join(__dirname, "..", "extension", "lib", "bookmarks.js"), "utf8"));
const BookmarkStore = globalThis.BookmarkStore;

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

const stats = await BookmarkStore.stats();
check("stats counts folders and urls", stats.folders === 4 && stats.urls === 5, JSON.stringify(stats));

const folders = await BookmarkStore.listFolders();
const devPath = folders.find((f) => f.id === "10")?.path;
check("listFolders builds full paths", devPath === "Bookmarks bar / Dev", devPath);

const dups = await BookmarkStore.findDuplicates();
const gh = dups.find((g) => g.url === "https://github.com");
check("findDuplicates groups shared URLs", dups.length === 1 && gh?.nodes.length === 2, JSON.stringify(dups));

const results = await BookmarkStore.searchWithPaths("github");
const r102 = results.find((r) => r.id === "102");
const r201 = results.find((r) => r.id === "201");
check("searchWithPaths attaches folder context",
  results.length === 2 && r102?.folder === "Bookmarks bar" && r201?.folder === "Other bookmarks",
  JSON.stringify(results));

// chrome.bookmarks.search returns folder Dev(10) for "Dev" plus React (url
// contains "dev"). Folder rows must be omitted; bookmark hits keep their path.
const rawDev = await chrome.bookmarks.search("Dev");
check("mock search returns folder hits like chrome.bookmarks.search",
  rawDev.some((n) => n.id === "10" && !n.url) && rawDev.some((n) => n.id === "101"),
  JSON.stringify(rawDev));
const devHits = await BookmarkStore.searchWithPaths("Dev");
const folderHit = devHits.find((r) => r.id === "10");
const reactHit = devHits.find((r) => r.id === "101");
check("searchWithPaths omits folder hits and keeps bookmark folder path",
  !folderHit &&
  devHits.every((r) => r.url) &&
  reactHit?.url === "https://react.dev" &&
  reactHit?.folder === "Bookmarks bar / Dev",
  JSON.stringify(devHits));

const all = await BookmarkStore.listBookmarks();
check("listBookmarks returns a flat list of all bookmarks with folders",
  all.length === 5 && all.every((b) => b.id && b.url && b.folder),
  JSON.stringify(all));

const scoped = await BookmarkStore.listBookmarks("Bookmarks bar/Dev");
check("listBookmarks scopes to a folder path and its subfolders",
  scoped.length === 2 && scoped.every((b) => b.folder === "Bookmarks bar / Dev"),
  JSON.stringify(scoped));

const exported = await BookmarkStore.exportTree();
check("exportTree unwraps to permanent roots with children",
  Array.isArray(exported.children) && exported.children.some((c) => c.title === "Bookmarks bar"),
  JSON.stringify(exported).slice(0, 120));

// importInto: a rootless container with one folder holding two bookmarks →
// 3 nodes created (the folder + 2 bookmarks), and the folder is created before
// its children so nesting works.
const importData = { children: [
  { title: "Imported", children: [
    { title: "A", url: "https://a.test" },
    { title: "B", url: "https://b.test" },
  ] },
] };
const createdCount = await BookmarkStore.importInto("2", importData);
const folderFirst = chrome.bookmarks._created[0];
check("importInto recreates the tree (folder then children)",
  createdCount === 3 &&
  chrome.bookmarks._created.length === 3 &&
  !folderFirst.url && folderFirst.title === "Imported",
  `created=${createdCount} nodes=${JSON.stringify(chrome.bookmarks._created)}`);

console.log(failed ? `\nBOOKMARKSTORE TESTS FAILED (${failed})` : "\nBOOKMARKSTORE TESTS PASSED");
process.exit(failed ? 1 : 0);
