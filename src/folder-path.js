// Folder-path codec for slash-separated MCP paths.
// Chrome titles may contain / and \ (e.g. "CI/CD"). Escape those inside each
// segment so list_folders paths round-trip through splitPath / ensurePath.
// Keep in lockstep with the copies in extension/lib/bookmarks.js.

// Escape \ first, then /, so a literal backslash never masquerades as an escape.
export function escapePathSegment(title) {
  return String(title ?? "").replace(/\\/g, "\\\\").replace(/\//g, "\\/");
}

export function joinFolderPath(titles) {
  return (titles || []).filter(Boolean).map(escapePathSegment).join(" / ");
}

// Split on unescaped "/", then unescape \X → X. Trim each segment (so
// "Bookmarks bar / Dev" and "Bookmarks bar/Dev" stay equivalent). Empty
// segments are dropped — same as the old split("/").trim().filter(Boolean).
export function splitPath(p) {
  const s = String(p || "");
  const out = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      if (i + 1 < s.length) buf += s[++i];
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
