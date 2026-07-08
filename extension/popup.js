// Popup: quick-add the current tab into a chosen folder.

const $ = (id) => document.getElementById(id);

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function fillFolders() {
  const folders = await BookmarkStore.listFolders();
  const sel = $("folder");
  sel.replaceChildren();
  for (const f of folders) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = " ".repeat(f.depth * 2) + (f.title || "(untitled)");
    sel.appendChild(opt);
  }
  // Default to the bookmarks bar (the shallowest first folder).
  const bar = folders.find(f => f.depth === 0);
  if (bar) sel.value = bar.id;
}

function setMsg(text, kind) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg " + (kind || "");
}

async function init() {
  await fillFolders();
  const tab = await currentTab();
  const tabEl = $("tab");
  tabEl.textContent = "";
  if (tab) {
    const b = document.createElement("b");
    b.textContent = tab.title || "";
    tabEl.appendChild(b);
    tabEl.appendChild(document.createElement("br"));
    tabEl.appendChild(document.createTextNode(tab.url || ""));
    $("title").value = tab.title || tab.url || "";
    $("add").dataset.url = tab.url || "";
  } else {
    tabEl.textContent = "No active tab.";
  }
}

$("add").addEventListener("click", async () => {
  const url = $("add").dataset.url;
  const title = $("title").value.trim() || url;
  const folderId = $("folder").value;
  if (!url) { setMsg("No URL to add.", "err"); return; }
  try {
    await BookmarkStore.createBookmark(folderId, title, url);
    setMsg("Added ✓ (syncing)", "ok");
  } catch (e) {
    setMsg("Error: " + e.message, "err");
  }
});

$("open").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
  window.close();
});

init();
