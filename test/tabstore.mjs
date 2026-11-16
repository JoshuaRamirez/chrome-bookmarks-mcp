// Unit tests for TabStore — the extension's tab and tab-group logic — run in
// Node against a mock of chrome.tabs / chrome.tabGroups / chrome.windows that
// keeps a real tab strip (order, group membership, cross-window moves).
//
// Run: node test/tabstore.mjs   (invoked by `npm test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Window 1: [10 Desk A | 11 Desk B] in group 100 "Desk Reports", 12 loose, [13] in group 101 "CAP"
// Window 2: 20 loose, 21 loose
let strip, groups, nextGroup;
function reset() {
  strip = {
    1: [ { id: 10, groupId: 100 }, { id: 11, groupId: 100 }, { id: 12, groupId: -1 }, { id: 13, groupId: 101 } ],
    2: [ { id: 20, groupId: -1 }, { id: 21, groupId: -1 } ],
  };
  groups = {
    100: { id: 100, windowId: 1, title: "Desk Reports", color: "red", collapsed: false },
    101: { id: 101, windowId: 1, title: "CAP", color: "green", collapsed: false },
  };
  nextGroup = 200;
}
const view = (winId) => strip[winId].map((t, index) => ({
  id: t.id, windowId: Number(winId), index, title: "T" + t.id, url: "https://t/" + t.id, active: index === 0, pinned: false, groupId: t.groupId,
}));
const allTabs = () => Object.keys(strip).flatMap(view);
const find = (id) => { const t = allTabs().find((x) => x.id === id); if (!t) throw new Error("No tab with id: " + id); return t; };
const take = (id) => { const t = find(id); return strip[t.windowId].splice(t.index, 1)[0]; };
const prune = () => { for (const g of Object.values(groups)) if (!allTabs().some((t) => t.groupId === g.id)) delete groups[g.id]; };

globalThis.chrome = {
  windows: { async getAll() { return Object.keys(strip).map((w) => ({ id: Number(w), focused: w === "1", incognito: false, tabs: view(w) })); } },
  tabs: {
    async get(id) { return find(id); },
    async query(q) { return allTabs().filter((t) => q.windowId == null || t.windowId === q.windowId); },
    async group({ tabIds, groupId, createProperties }) {
      let gid = groupId, win;
      if (gid == null) {
        win = createProperties?.windowId ?? find(tabIds[0]).windowId;
        gid = nextGroup++;
        groups[gid] = { id: gid, windowId: win, title: "", color: "grey", collapsed: false };
      } else {
        if (!groups[gid]) throw new Error("No group with id: " + gid);
        win = groups[gid].windowId;
      }
      for (const id of tabIds) {
        const t = take(id); t.groupId = gid;
        const row = strip[win];
        let last = -1; row.forEach((x, i) => { if (x.groupId === gid) last = i; });
        row.splice(last < 0 ? row.length : last + 1, 0, t);
      }
      prune();
      return gid;
    },
    async ungroup(ids) { for (const id of ids) { const t = find(id); strip[t.windowId][t.index].groupId = -1; } prune(); },
    async move(ids, { windowId, index }) {
      const out = [];
      for (const id of ids) {
        const from = find(id); const win = windowId ?? from.windowId;
        const t = take(id); if (win !== from.windowId) t.groupId = -1;
        strip[win].splice(index === -1 ? strip[win].length : index, 0, t);
        out.push(find(id));
      }
      prune();
      return out.length === 1 ? out[0] : out;
    },
  },
  tabGroups: {
    async query(q) { return Object.values(groups).filter((g) => q.windowId == null || g.windowId === q.windowId).map((g) => ({ ...g })); },
    async get(id) { if (!groups[id]) throw new Error("No group with id: " + id); return { ...groups[id] }; },
    async update(id, props) { if (!groups[id]) throw new Error("No group with id: " + id); Object.assign(groups[id], props); return { ...groups[id] }; },
    async move(id, { windowId, index }) {
      const g = groups[id]; if (!g) throw new Error("No group with id: " + id);
      const members = strip[g.windowId].filter((t) => t.groupId === id);
      strip[g.windowId] = strip[g.windowId].filter((t) => t.groupId !== id);
      const win = windowId ?? g.windowId; g.windowId = win;
      strip[win].splice(index === -1 ? strip[win].length : index, 0, ...members);
      return { ...g };
    },
  },
};

vm.runInThisContext(readFileSync(join(__dirname, "..", "extension", "lib", "tabs.js"), "utf8"));
const TabStore = globalThis.TabStore;

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`✓ ${name}`);
  else { console.error(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}
async function throws(fn) { try { await fn(); return null; } catch (e) { return e.message; } }
const order = (w) => strip[w].map((t) => `${t.id}:${t.groupId}`).join(" ");

reset();
const wins = await TabStore.listWindows();
const w1 = wins.find((w) => w.windowId === 1);
check("listWindows returns windows with groups and tabs in strip order",
  wins.length === 2 && w1.groups.length === 2 && w1.tabs.map((t) => t.id).join() === "10,11,12,13", JSON.stringify(wins));
check("listWindows reports a loose tab's groupId as null",
  w1.tabs.find((t) => t.id === 12).groupId === null && w1.tabs.find((t) => t.id === 10).groupId === 100);
check("listWindows narrows to one window", (await TabStore.listWindows(2)).length === 1);

const lg = await TabStore.listGroups();
check("listGroups counts each group's tabs",
  lg.find((g) => g.id === 100).tabCount === 2 && lg.find((g) => g.id === 101).tabCount === 1, JSON.stringify(lg));

reset();
let r = await TabStore.groupTabs({ tabIds: [12], groupTitle: "desk reports" });
check("groupTabs joins the existing group by title, case-insensitively",
  r.id === 100 && r.created === false && order(1) === "10:100 11:100 12:100 13:101", order(1));

reset();
r = await TabStore.groupTabs({ tabIds: [21, 20], groupId: 101 });
check("groupTabs moves tabs across windows into the group, in the order given",
  order(1) === "10:100 11:100 12:-1 13:101 21:101 20:101" && order(2) === "", `${order(1)} | ${order(2)}`);

reset();
r = await TabStore.groupTabs({ tabIds: [20, 21], groupTitle: "Hindsight", color: "pink" });
check("groupTabs makes a new titled, coloured group when none matches",
  r.created === true && r.title === "Hindsight" && r.color === "pink" && r.windowId === 2 && order(2) === `20:${r.id} 21:${r.id}`, JSON.stringify(r));

reset();
groups[102] = { id: 102, windowId: 2, title: "CAP", color: "blue", collapsed: false }; strip[2][0].groupId = 102;
let msg = await throws(() => TabStore.groupTabs({ tabIds: [12], groupTitle: "CAP" }));
check("groupTabs refuses an ambiguous title", /2 groups are titled/.test(msg || "") && order(1) === "10:100 11:100 12:-1 13:101", msg);
r = await TabStore.groupTabs({ tabIds: [12], groupTitle: "CAP", windowId: 1 });
check("groupTabs resolves an ambiguous title by window", r.id === 101, JSON.stringify(r));

reset();
msg = await throws(() => TabStore.groupTabs({ tabIds: [12], groupTitle: "X", color: "mauve" }));
check("groupTabs rejects an unknown colour before changing anything", /color must be one of/.test(msg || "") && order(1) === "10:100 11:100 12:-1 13:101", msg);
msg = await throws(() => TabStore.groupTabs({ tabIds: [] }));
check("groupTabs rejects an empty tab list", /non-empty/.test(msg || ""), msg);

reset();
await TabStore.ungroupTabs([11]);
check("ungroupTabs takes a tab out of its group in place", order(1) === "10:100 11:-1 12:-1 13:101", order(1));

reset();
const moved = await TabStore.moveTabs({ tabIds: [10], windowId: 2 });
check("moveTabs moves to the end of another window and drops the group",
  order(2) === "20:-1 21:-1 10:-1" && moved[0].windowId === 2 && moved[0].groupId === null, order(2));
await TabStore.moveTabs({ tabIds: [21], index: 0 });
check("moveTabs reorders within the tab's own window", order(2) === "21:-1 20:-1 10:-1", order(2));

reset();
const ug = await TabStore.updateGroup({ groupId: 101, title: "CAP v2", collapsed: true });
check("updateGroup renames and collapses", ug.title === "CAP v2" && ug.collapsed === true && ug.color === "green", JSON.stringify(ug));
msg = await throws(() => TabStore.updateGroup({ groupId: 101 }));
check("updateGroup refuses an empty change", /nothing to change/.test(msg || ""), msg);

reset();
const mg = await TabStore.moveGroup({ groupId: 100, windowId: 2 });
check("moveGroup carries the group's tabs to the other window",
  mg.windowId === 2 && order(2) === "20:-1 21:-1 10:100 11:100" && order(1) === "12:-1 13:101", `${order(1)} | ${order(2)}`);

console.log(failed ? `\nTABSTORE TESTS FAILED (${failed})` : "\nTABSTORE TESTS PASSED");
process.exit(failed ? 1 : 0);
