// TabStore — a thin wrapper over chrome.tabs, chrome.windows and
// chrome.tabGroups. It lists open windows with their tabs and tab groups, and
// moves tabs between windows and groups. Every move here is a real move: the
// tab keeps its page, history and scroll position (nothing is closed or
// reloaded). Loaded as a classic script, like BookmarkStore.

class TabStore {
  static COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
  static NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

  static _tab(t) {
    return {
      id: t.id, windowId: t.windowId, index: t.index,
      title: t.title || "", url: t.url || t.pendingUrl || "",
      active: !!t.active, pinned: !!t.pinned,
      groupId: t.groupId == null || t.groupId === TabStore.NO_GROUP ? null : t.groupId,
    };
  }
  static _group(g) {
    return { id: g.id, windowId: g.windowId, title: g.title || "", color: g.color, collapsed: !!g.collapsed };
  }

  // Every normal window with its groups and tabs, in tab-strip order.
  // windowId narrows to one window.
  static async listWindows(windowId) {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const groups = (await chrome.tabGroups.query({})).map(TabStore._group);
    return wins
      .filter((w) => windowId == null || w.id === windowId)
      .map((w) => ({
        windowId: w.id, focused: !!w.focused, incognito: !!w.incognito,
        groups: groups.filter((g) => g.windowId === w.id),
        tabs: (w.tabs || []).slice().sort((a, b) => a.index - b.index).map(TabStore._tab),
      }));
  }

  static async listGroups(windowId) {
    const q = windowId == null ? {} : { windowId };
    const groups = (await chrome.tabGroups.query(q)).map(TabStore._group);
    const tabs = await chrome.tabs.query(q);
    return groups.map((g) => ({ ...g, tabCount: tabs.filter((t) => t.groupId === g.id).length }));
  }

  static _ids(tabIds) {
    const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number);
    if (!ids.length || ids.some((n) => !Number.isInteger(n))) throw new Error("tabIds must be a non-empty list of tab ids");
    return ids;
  }

  // Put tabs into a group; they land at the end of it, in the order given.
  // Target, in order of preference: groupId; else groupTitle, which joins the
  // one existing group with that title (case-insensitive; in windowId when
  // given) or makes a new one; else a new untitled group. A new group is made
  // in windowId, or in the first tab's window. Tabs from another window are
  // moved across.
  static async groupTabs({ tabIds, groupId, groupTitle, windowId, color }) {
    const ids = TabStore._ids(tabIds);
    if (color != null && !TabStore.COLORS.includes(color)) throw new Error(`color must be one of: ${TabStore.COLORS.join(", ")}`);
    let target = groupId;
    let created = false;
    if (target == null && groupTitle) {
      const want = String(groupTitle).trim().toLowerCase();
      const all = await chrome.tabGroups.query(windowId == null ? {} : { windowId });
      const hits = all.filter((g) => (g.title || "").trim().toLowerCase() === want);
      if (hits.length > 1) {
        throw new Error(`${hits.length} groups are titled "${groupTitle}" (ids ${hits.map((g) => g.id).join(", ")}); pass groupId`);
      }
      if (hits.length === 1) target = hits[0].id;
    }
    if (target == null) {
      const win = windowId != null ? windowId : (await chrome.tabs.get(ids[0])).windowId;
      target = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: win } });
      created = true;
      const props = {};
      if (groupTitle) props.title = String(groupTitle);
      if (color != null) props.color = color;
      if (Object.keys(props).length) await chrome.tabGroups.update(target, props);
    } else {
      // One at a time, so the tabs end up in the order given.
      for (const id of ids) await chrome.tabs.group({ tabIds: [id], groupId: target });
      if (color != null) await chrome.tabGroups.update(target, { color });
    }
    const g = TabStore._group(await chrome.tabGroups.get(target));
    return { ...g, created, tabIds: ids };
  }

  static async ungroupTabs(tabIds) {
    const ids = TabStore._ids(tabIds);
    await chrome.tabs.ungroup(ids);
    return { ungrouped: ids };
  }

  // Move tabs to a position in a window (index -1 or omitted = the end;
  // windowId omitted = each tab's own window). A tab moved to another window
  // leaves its group.
  static async moveTabs({ tabIds, windowId, index }) {
    const ids = TabStore._ids(tabIds);
    const props = { index: index == null ? -1 : index };
    if (windowId != null) props.windowId = windowId;
    const moved = await chrome.tabs.move(ids, props);
    return (Array.isArray(moved) ? moved : [moved]).map(TabStore._tab);
  }

  static async updateGroup({ groupId, title, color, collapsed }) {
    if (groupId == null) throw new Error("groupId is required");
    if (color != null && !TabStore.COLORS.includes(color)) throw new Error(`color must be one of: ${TabStore.COLORS.join(", ")}`);
    const props = {};
    if (title != null) props.title = String(title);
    if (color != null) props.color = color;
    if (collapsed != null) props.collapsed = !!collapsed;
    if (!Object.keys(props).length) throw new Error("nothing to change: pass title, color or collapsed");
    return TabStore._group(await chrome.tabGroups.update(groupId, props));
  }

  // Move a whole group, tabs and all, within its window or to another one.
  static async moveGroup({ groupId, windowId, index }) {
    if (groupId == null) throw new Error("groupId is required");
    const props = { index: index == null ? -1 : index };
    if (windowId != null) props.windowId = windowId;
    return TabStore._group(await chrome.tabGroups.move(groupId, props));
  }
}

globalThis.TabStore = TabStore;
