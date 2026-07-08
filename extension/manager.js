// Full bookmark manager page. All UI is built with safe DOM construction.
// Every mutation goes through BookmarkStore (chrome.bookmarks), so changes sync.

// ---- tiny DOM helper -------------------------------------------------------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return n;
}

// ---- modal + form ----------------------------------------------------------
function showModal(title, contentNode, buttons) {
  return new Promise((resolve) => {
    const root = document.getElementById("modalRoot");
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    const close = (val) => { root.textContent = ""; document.removeEventListener("keydown", onKey); resolve(val); };
    document.addEventListener("keydown", onKey);
    const btnEls = buttons.map(b => el("button", { class: b.kind || "", onClick: () => close(b.value) }, b.label));
    const modal = el("div", { class: "modal" }, el("h2", { text: title }), contentNode, el("div", { class: "buttons" }, ...btnEls));
    const backdrop = el("div", { class: "backdrop", onClick: (e) => { if (e.target === backdrop) close(null); } }, modal);
    root.appendChild(backdrop);
    const first = modal.querySelector("input, textarea, select");
    if (first) first.focus();
  });
}

async function showForm(title, fields, okLabel = "Save") {
  const inputs = {};
  const content = el("div");
  for (const f of fields) {
    content.appendChild(el("label", { text: f.label }));
    let input;
    if (f.type === "select") {
      input = el("select");
      for (const o of f.options) input.appendChild(el("option", { value: o.value }, o.label));
      if (f.value != null) input.value = f.value;
    } else if (f.type === "textarea") {
      input = el("textarea");
      if (f.value) input.value = f.value;
    } else {
      input = el("input", { type: f.type || "text" });
      if (f.value != null) input.value = f.value;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") content.closest(".modal").querySelector(".buttons button.primary, .buttons button:last-child").click(); });
    }
    inputs[f.name] = input;
    content.appendChild(input);
  }
  const res = await showModal(title, content, [{ label: "Cancel", value: null }, { label: okLabel, kind: "primary", value: "ok" }]);
  if (res !== "ok") return null;
  const out = {};
  for (const k in inputs) out[k] = inputs[k].value;
  return out;
}

async function folderOptions() {
  const folders = await BookmarkStore.listFolders();
  return folders.map(f => ({ value: f.id, label: "  ".repeat(f.depth) + (f.title || "(untitled)") }));
}

// ---- operations ------------------------------------------------------------
async function opNewFolder(parentId) {
  const opts = await folderOptions();
  const v = await showForm("New folder", [
    { name: "title", label: "Folder name", value: "" },
    { name: "parent", label: "Inside folder", type: "select", options: opts, value: parentId || opts[0]?.value }
  ], "Create");
  if (!v || !v.title.trim()) return;
  await BookmarkStore.createFolder(v.parent, v.title.trim());
  render();
}

async function opNewBookmark(parentId) {
  const opts = await folderOptions();
  const v = await showForm("Add bookmark", [
    { name: "title", label: "Name", value: "" },
    { name: "url", label: "URL", value: "https://" },
    { name: "parent", label: "Folder", type: "select", options: opts, value: parentId || opts[0]?.value }
  ], "Add");
  if (!v || !v.url.trim() || v.url.trim() === "https://") return;
  await BookmarkStore.createBookmark(v.parent, v.title.trim() || v.url.trim(), v.url.trim());
  render();
}

async function opRename(node) {
  const v = await showForm("Rename", [{ name: "title", label: "Name", value: node.title || "" }], "Save");
  if (!v) return;
  await BookmarkStore.rename(node.id, v.title);
  render();
}

async function opEdit(node) {
  const v = await showForm("Edit bookmark", [
    { name: "title", label: "Name", value: node.title || "" },
    { name: "url", label: "URL", value: node.url || "" }
  ], "Save");
  if (!v) return;
  await BookmarkStore.rename(node.id, v.title);
  await BookmarkStore.setUrl(node.id, v.url.trim());
  render();
}

async function opMove(node) {
  const opts = await folderOptions();
  const v = await showForm(`Move "${node.title || node.url}"`, [
    { name: "parent", label: "Move to folder", type: "select", options: opts, value: node.parentId }
  ], "Move");
  if (!v) return;
  await BookmarkStore.move(node.id, v.parent);
  render();
}

async function opDelete(node) {
  const isFolder = !node.url;
  const tail = isFolder ? " and everything inside it" : "";
  const ok = await showModal("Delete?",
    el("div", { text: `Delete "${node.title || node.url}"${tail}? This cannot be undone.` }),
    [{ label: "Cancel", value: null }, { label: "Delete", kind: "danger", value: "ok" }]);
  if (ok !== "ok") return;
  await BookmarkStore.remove(node.id, isFolder);
  render();
}

async function opDedupe() {
  const groups = await BookmarkStore.findDuplicates();
  if (!groups.length) {
    await showModal("Duplicates", el("div", { class: "empty", text: "No duplicate URLs found." }), [{ label: "Close", value: null }]);
    return;
  }
  const toRemove = new Set();
  const content = el("div");
  for (const g of groups) {
    const box = el("div", { class: "dupgroup" }, el("div", { class: "u", text: g.url }));
    g.nodes.forEach((nd, i) => {
      const item = el("div", { class: "item" });
      if (i === 0) {
        item.appendChild(el("span", { class: "keep", text: "KEEP" }));
      } else {
        const cb = el("input", { type: "checkbox" });
        cb.checked = true; toRemove.add(nd.id);
        cb.addEventListener("change", () => cb.checked ? toRemove.add(nd.id) : toRemove.delete(nd.id));
        item.appendChild(cb);
      }
      item.appendChild(el("span", { text: `${nd.title || "(untitled)"}  —  ${nd.folder}` }));
      box.appendChild(item);
    });
    content.appendChild(box);
  }
  const res = await showModal(`${groups.length} duplicate URL group(s)`, content,
    [{ label: "Cancel", value: null }, { label: "Remove checked", kind: "danger", value: "ok" }]);
  if (res !== "ok") return;
  for (const id of toRemove) await BookmarkStore.remove(id, false);
  render();
}

async function opExport() {
  const data = await BookmarkStore.exportTree();
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `bookmarks-${stamp}.json` });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function opImport() {
  const opts = await folderOptions();
  const fileInput = el("input", { type: "file", accept: ".json,application/json" });
  const sel = el("select");
  opts.forEach(o => sel.appendChild(el("option", { value: o.value }, o.label)));
  const content = el("div", {},
    el("label", { text: "JSON file (from Export)" }), fileInput,
    el("label", { text: "Import into folder" }), sel);
  const res = await showModal("Import bookmarks", content,
    [{ label: "Cancel", value: null }, { label: "Import", kind: "primary", value: "ok" }]);
  if (res !== "ok") return;
  const file = fileInput.files[0];
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { alert("Invalid JSON: " + e.message); return; }
  const n = await BookmarkStore.importInto(sel.value, data);
  alert(`Imported ${n} item(s).`);
  render();
}

// ---- rendering -------------------------------------------------------------
function folderActions(node, permanent) {
  const stop = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
  const actions = el("span", { class: "actions" },
    el("button", { class: "mini", title: "Add bookmark here", onClick: stop(() => opNewBookmark(node.id)) }, "+url"),
    el("button", { class: "mini", title: "New subfolder", onClick: stop(() => opNewFolder(node.id)) }, "+dir"));
  if (!permanent) {
    actions.appendChild(el("button", { class: "mini", onClick: stop(() => opRename(node)) }, "rename"));
    actions.appendChild(el("button", { class: "mini", onClick: stop(() => opMove(node)) }, "move"));
    actions.appendChild(el("button", { class: "mini danger", onClick: stop(() => opDelete(node)) }, "del"));
  }
  return actions;
}

function renderFolder(node, permanent) {
  const det = el("details");
  if (permanent) det.open = true;
  const count = (node.children || []).length;
  const twisty = el("span", { class: "twisty", text: permanent ? "▾" : "▸" });
  const summary = el("summary", {}, twisty,
    el("span", { class: "folder-name", text: node.title || "(untitled)" }),
    el("span", { class: "count", text: count ? `(${count})` : "(empty)" }),
    folderActions(node, permanent));
  det.addEventListener("toggle", () => { twisty.textContent = det.open ? "▾" : "▸"; });
  det.appendChild(summary);
  const wrap = el("div", { class: "children" });
  for (const ch of (node.children || [])) wrap.appendChild(ch.url ? renderBookmark(ch) : renderFolder(ch, false));
  det.appendChild(wrap);
  return det;
}

function renderBookmark(node) {
  return el("div", { class: "row" },
    el("span", { class: "twisty", text: "•" }),
    el("a", { href: node.url, target: "_blank", title: node.url, text: node.title || node.url }),
    el("span", { class: "actions" },
      el("button", { class: "mini", onClick: () => opEdit(node) }, "edit"),
      el("button", { class: "mini", onClick: () => opMove(node) }, "move"),
      el("button", { class: "mini danger", onClick: () => opDelete(node) }, "del")));
}

async function renderTree() {
  const tree = document.getElementById("tree");
  tree.textContent = "";
  const [root] = await BookmarkStore.getTree();
  for (const top of (root.children || [])) tree.appendChild(renderFolder(top, true));
}

async function renderSearch(query) {
  const tree = document.getElementById("tree");
  tree.textContent = "";
  const folders = await BookmarkStore.listFolders();
  const pathById = new Map(folders.map(f => [f.id, f.path]));
  const results = (await BookmarkStore.search(query)).filter(n => n.url);
  if (!results.length) { tree.appendChild(el("div", { class: "empty", text: "No matches." })); return; }
  for (const n of results) {
    const meta = el("div", { class: "meta" },
      el("div", { class: "t", text: n.title || "(untitled)" }),
      el("a", { class: "u", href: n.url, target: "_blank", text: n.url }),
      el("div", { class: "f", text: pathById.get(n.parentId) || "" }));
    const actions = el("span", { class: "actions", style: "display:inline-flex" },
      el("button", { class: "mini", onClick: () => opEdit(n) }, "edit"),
      el("button", { class: "mini", onClick: () => opMove(n) }, "move"),
      el("button", { class: "mini danger", onClick: () => opDelete(n) }, "del"));
    tree.appendChild(el("div", { class: "result" }, meta, actions));
  }
}

async function updateStats() {
  const s = await BookmarkStore.stats();
  document.getElementById("stats").textContent = `${s.urls} bookmarks · ${s.folders} folders`;
}

async function render() {
  const q = document.getElementById("search").value.trim();
  await updateStats();
  if (q) await renderSearch(q); else await renderTree();
}

// ---- wire up ---------------------------------------------------------------
document.getElementById("newFolder").addEventListener("click", () => opNewFolder());
document.getElementById("newBookmark").addEventListener("click", () => opNewBookmark());
document.getElementById("dedupe").addEventListener("click", opDedupe);
document.getElementById("export").addEventListener("click", opExport);
document.getElementById("import").addEventListener("click", opImport);
document.getElementById("refresh").addEventListener("click", render);
let searchTimer;
document.getElementById("search").addEventListener("input", () => {
  clearTimeout(searchTimer); searchTimer = setTimeout(render, 200);
});
render();
