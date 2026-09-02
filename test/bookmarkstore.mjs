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
import { splitPath } from "../src/folder-path.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- mock tree ------------------------------------------------------------
// root(0)
//   Bookmarks bar(1)
//     Dev(10)
//       "MCP Spec"  https://modelcontextprotocol.io   (100)
//       "React"     https://react.dev                 (101)
//     "GitHub"      https://github.com                (102)
//     CI/CD(30)                  <- title contains "/"
//       "Jenkins"   https://jenkins.example           (300)
//       Nested(31)
//         "Nested job" https://nested.example         (310)
//     CI(40)                     <- real nested CI → CD (contrast with CI/CD)
//       CD(41)
//         "Nested CD" https://cd.example              (410)
//     foo\bar(50)                <- title contains "\"
//       "Slash"     https://backslash.example         (500)
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
      { id: "30", title: "CI/CD", parentId: "1", children: [
        { id: "300", title: "Jenkins", url: "https://jenkins.example", parentId: "30" },
        { id: "31", title: "Nested", parentId: "30", children: [
          { id: "310", title: "Nested job", url: "https://nested.example", parentId: "31" },
        ] },
      ] },
      { id: "40", title: "CI", parentId: "1", children: [
        { id: "41", title: "CD", parentId: "40", children: [
          { id: "410", title: "Nested CD", url: "https://cd.example", parentId: "41" },
        ] },
      ] },
      { id: "50", title: "foo\\bar", parentId: "1", children: [
        { id: "500", title: "Slash", url: "https://backslash.example", parentId: "50" },
      ] },
    ] },
    { id: "2", title: "Other bookmarks", parentId: "0", children: [
      { id: "20", title: "News", parentId: "2", children: [
        { id: "200", title: "HN", url: "https://news.ycombinator.com", parentId: "20" },
      ] },
      { id: "201", title: "Dupe GH", url: "https://github.com", parentId: "2" },
    ] },
  ],
};

// Resolve title segments against the mock tree the same way ensurePath does
// (match existing folder titles; do not create). Proves a list_folders path
// round-trips to that folder id, not a nested mis-read of "/" in the title.
function resolveBySegments(segments) {
  let cur = TREE;
  for (const seg of segments) {
    const kids = (cur.children || []).filter((k) => !k.url);
    cur = kids.find((k) => (k.title || "").toLowerCase() === String(seg).toLowerCase());
    if (!cur) return null;
  }
  return cur;
}

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
check("stats counts folders and urls", stats.folders === 9 && stats.urls === 9, JSON.stringify(stats));

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
  all.length === 9 && all.every((b) => b.id && b.url && b.folder),
  JSON.stringify(all));

const scoped = await BookmarkStore.listBookmarks("Bookmarks bar/Dev");
check("listBookmarks scopes to a folder path and its subfolders",
  scoped.length === 2 && scoped.every((b) => b.folder === "Bookmarks bar / Dev"),
  JSON.stringify(scoped));

const scopedLower = await BookmarkStore.listBookmarks("bookmarks bar/dev");
check("listBookmarks matches folder_path case-insensitively and keeps Chrome folder casing",
  scopedLower.length === 2 &&
  scopedLower.every((b) => b.folder === "Bookmarks bar / Dev") &&
  scopedLower.some((b) => b.id === "100") &&
  scopedLower.some((b) => b.id === "101"),
  JSON.stringify(scopedLower));

const otherTitleCase = await BookmarkStore.listBookmarks("Other Bookmarks");
check("listBookmarks matches USAGE Other Bookmarks casing and keeps Chrome folder casing",
  otherTitleCase.length === 2 &&
  otherTitleCase.some((b) => b.id === "200" && b.folder === "Other bookmarks / News") &&
  otherTitleCase.some((b) => b.id === "201" && b.folder === "Other bookmarks"),
  JSON.stringify(otherTitleCase));

// A provided folderPath that normalizes to empty must throw — not list-all.
// Sibling write tools (ensurePath / apply_moves) use the same "empty path"
// message. Omit (listBookmarks() above) still lists everything.
for (const raw of ["/", "///", "   "]) {
  let threw = false;
  let message = "";
  let leaked = null;
  try {
    leaked = await BookmarkStore.listBookmarks(raw);
  } catch (e) {
    threw = true;
    message = String(e?.message || e);
  }
  check(
    `listBookmarks rejects empty-normalized folder_path ${JSON.stringify(raw)}`,
    threw && /empty path/.test(message),
    threw ? message : `returned ${leaked?.length} bookmarks (must not list-all)`
  );
}

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

// --- slash / backslash titles: emit → splitPath → same folder ---------------
check("splitPath keeps ordinary slash paths as title segments",
  JSON.stringify(splitPath("Bookmarks bar / Dev")) === JSON.stringify(["Bookmarks bar", "Dev"]) &&
  JSON.stringify(splitPath("Bookmarks bar/Dev")) === JSON.stringify(["Bookmarks bar", "Dev"]) &&
  JSON.stringify(splitPath("bookmarks bar/dev")) === JSON.stringify(["bookmarks bar", "dev"]),
  JSON.stringify(splitPath("Bookmarks bar / Dev")));

check("splitPath treats escaped / and \\ as title characters",
  JSON.stringify(splitPath("Bookmarks bar / CI\\/CD")) === JSON.stringify(["Bookmarks bar", "CI/CD"]) &&
  JSON.stringify(splitPath("Bookmarks bar/CI\\/CD")) === JSON.stringify(["Bookmarks bar", "CI/CD"]) &&
  JSON.stringify(splitPath("Bookmarks bar / foo\\\\bar")) === JSON.stringify(["Bookmarks bar", "foo\\bar"]),
  JSON.stringify({
    cicd: splitPath("Bookmarks bar / CI\\/CD"),
    bs: splitPath("Bookmarks bar / foo\\\\bar"),
  }));

check("splitPath keeps a trailing backslash as a literal (and \\\\ still unescapes)",
  JSON.stringify(splitPath("Bookmarks bar / foo\\")) === JSON.stringify(["Bookmarks bar", "foo\\"]) &&
  JSON.stringify(splitPath("Bookmarks bar / foo\\\\")) === JSON.stringify(["Bookmarks bar", "foo\\"]),
  JSON.stringify({
    trailing: splitPath("Bookmarks bar / foo\\"),
    escaped: splitPath("Bookmarks bar / foo\\\\"),
  }));

check("splitPath keeps a legacy unescaped backslash before a non-escape character",
  JSON.stringify(splitPath("Bookmarks bar/foo\\bar")) === JSON.stringify(["Bookmarks bar", "foo\\bar"]),
  JSON.stringify(splitPath("Bookmarks bar/foo\\bar")));

check("splitPath still drops empty segments (empty path)",
  JSON.stringify(splitPath("/")) === "[]" &&
  JSON.stringify(splitPath("///")) === "[]" &&
  JSON.stringify(splitPath("   ")) === "[]",
  JSON.stringify(splitPath("///")));

const cicdFolder = folders.find((f) => f.id === "30");
const cicdPath = cicdFolder?.path;
const cicdSegs = splitPath(cicdPath);
check("listFolders emits an escaped path for a CI/CD title",
  cicdPath === "Bookmarks bar / CI\\/CD",
  cicdPath);
check("listFolders CI/CD path round-trips through splitPath to that folder (not nested CI→CD)",
  JSON.stringify(cicdSegs) === JSON.stringify(["Bookmarks bar", "CI/CD"]) &&
  resolveBySegments(cicdSegs)?.id === "30" &&
  resolveBySegments(splitPath("Bookmarks bar/CI/CD"))?.id === "41",
  JSON.stringify({ cicdPath, cicdSegs, nested: resolveBySegments(splitPath("Bookmarks bar/CI/CD"))?.id }));

const nestedFolder = folders.find((f) => f.id === "31");
check("listFolders escapes / in ancestor titles on descendant paths",
  nestedFolder?.path === "Bookmarks bar / CI\\/CD / Nested",
  nestedFolder?.path);

const bsFolder = folders.find((f) => f.id === "50");
check("listFolders escapes backslash in titles and splitPath round-trips",
  bsFolder?.path === "Bookmarks bar / foo\\\\bar" &&
  JSON.stringify(splitPath(bsFolder?.path)) === JSON.stringify(["Bookmarks bar", "foo\\bar"]) &&
  resolveBySegments(splitPath(bsFolder?.path))?.id === "50",
  bsFolder?.path);

const cicdHits = await BookmarkStore.listBookmarks(cicdPath);
check("listBookmarks with the CI/CD list_folders path scopes to that folder and subfolders",
  cicdHits.length === 2 &&
  cicdHits.some((b) => b.id === "300" && b.folder === "Bookmarks bar / CI\\/CD") &&
  cicdHits.some((b) => b.id === "310" && b.folder === "Bookmarks bar / CI\\/CD / Nested") &&
  cicdHits.every((b) => b.id !== "410"),
  JSON.stringify(cicdHits));

const falsePrefix = await BookmarkStore.listBookmarks("Bookmarks bar/CI");
check("listBookmarks Bookmarks bar/CI does not match a CI/CD title (false prefix)",
  falsePrefix.length === 1 &&
  falsePrefix[0].id === "410" &&
  falsePrefix[0].folder === "Bookmarks bar / CI / CD" &&
  falsePrefix.every((b) => b.id !== "300" && b.id !== "310"),
  JSON.stringify(falsePrefix));

const nestedCd = await BookmarkStore.listBookmarks("Bookmarks bar/CI/CD");
check("listBookmarks unescaped Bookmarks bar/CI/CD is the nested CI→CD folder",
  nestedCd.length === 1 && nestedCd[0].id === "410",
  JSON.stringify(nestedCd));

const bsHits = await BookmarkStore.listBookmarks(bsFolder?.path);
check("listBookmarks scopes a backslash title via its escaped list_folders path",
  bsHits.length === 1 && bsHits[0].id === "500" && bsHits[0].folder === "Bookmarks bar / foo\\\\bar",
  JSON.stringify(bsHits));

const legacyBs = await BookmarkStore.listBookmarks("Bookmarks bar/foo\\bar");
check("listBookmarks accepts a legacy unescaped backslash path",
  legacyBs.length === 1 && legacyBs[0].id === "500",
  JSON.stringify(legacyBs));

const searchJenkins = await BookmarkStore.searchWithPaths("Jenkins");
check("searchWithPaths emits escaped folder paths for slash titles",
  searchJenkins.length === 1 && searchJenkins[0].folder === "Bookmarks bar / CI\\/CD",
  JSON.stringify(searchJenkins));

console.log(failed ? `\nBOOKMARKSTORE TESTS FAILED (${failed})` : "\nBOOKMARKSTORE TESTS PASSED");
process.exit(failed ? 1 : 0);
