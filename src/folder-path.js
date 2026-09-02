// Folder-path codec for slash-separated MCP paths.
// Chrome titles may contain / and \ (e.g. "CI/CD") and leading/trailing
// spaces (e.g. " Dev"). Escape / and \ inside each segment; splitPath drops
// only " / " separator padding so list_folders paths round-trip through
// ensurePath. Keep in lockstep with the copies in extension/lib/bookmarks.js.

// Escape \ first, then /, so a literal backslash never masquerades as an escape.
export function escapePathSegment(title) {
  return String(title ?? "").replace(/\\/g, "\\\\").replace(/\//g, "\\/");
}

export function joinFolderPath(titles) {
  return (titles || []).filter(Boolean).map(escapePathSegment).join(" / ");
}

// Split on unescaped "/", then unescape only the documented sequences
// (\/ → /, \\ → \). A backslash before any other character, or a trailing
// backslash, is kept as a literal so legacy paths like "foo\bar" and "foo\"
// still name those titles.
// joinFolderPath uses " / " between segments. On an unescaped "/", drop at
// most one trailing space before the slash and at most one leading space
// after it so "Bookmarks bar / Dev" and "Bookmarks bar/Dev" stay equivalent
// without .trim() on the whole segment (Chrome treats " Dev" ≠ "Dev" ≠ "Dev ").
// Tabs and extra title-edge spaces are kept. Empty segments are dropped.
// A whitespace-only path ("", "   ") is empty — same as "/", "///".
// Trim only the first segment (permanent root): join never emits leading
// path padding, but humans type " Bookmarks bar / Dev". Writes already
// accept that via permanentRootAlias.trim(); listBookmarks compares titles
// without alias expansion, so the root must be normalized here. Child
// segments keep edge spaces.
export function splitPath(p) {
  const s = String(p || "");
  if (!s.trim()) return [];
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
      if (buf.endsWith(" ")) buf = buf.slice(0, -1);
      out.push(buf);
      buf = "";
      if (s[i + 1] === " ") i++;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  const segs = out.filter(Boolean);
  if (segs.length) segs[0] = segs[0].trim();
  return segs.filter(Boolean);
}
