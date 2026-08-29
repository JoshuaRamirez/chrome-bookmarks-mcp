# Usage walkthrough

Concrete examples of driving the bookmark tools through Claude. These are plain
requests you type in Claude Code; Claude picks the matching tool. All edits go
through `chrome.bookmarks`, so they sync across your signed-in Chrome instances.

> First time? Load the extension (see the README), then start here.

## 1. Confirm the bridge is live

> **You:** Are my bookmarks connected?

Claude calls `bookmarks_status`. Connected looks like:

```json
{ "connected": true, "port": 8765, "message": "Extension bridge connected — all bookmark tools are ready." }
```

If it comes back `connected: false`, the response includes a `fix` list — follow
those steps and ask again. That is usually open Chrome and load the extension
unpacked, but `connected: false` can also be a bind failure (EADDRINUSE — another
server already on the port); follow the `fix` list the tool returns.

## 2. Get the lay of the land

> **You:** How many bookmarks and folders do I have, and what are my top-level folders?

Claude calls `stats` and `list_folders`:

```json
{ "folders": 91, "urls": 848 }
```

`list_folders` returns each folder with its `id`, `depth`, and full `path`
(e.g. `Other Bookmarks / Dev / Web / React`) — the `path` is what you pass to
folder-targeting tools.

## 3. Add a bookmark to a specific folder

> **You:** Bookmark https://modelcontextprotocol.io as "MCP Spec" under Dev → Standards.

Claude calls `add_bookmark` with `folder_path: "Other bookmarks/Dev/Standards"`.
The folder is created if it doesn't exist. Top level must be one of
`Bookmarks bar`, `Other bookmarks`, or `Mobile bookmarks`.

## 4. Find and remove duplicates — safely

> **You:** Do I have duplicate bookmarks? Show me before deleting anything.

Claude calls `find_duplicates` (read-only), then `remove_duplicates` with
`dry_run: true`:

```json
{ "groups": 12, "would_remove": 18, "removals": [ /* … */ ] }
```

Review, then:

> **You:** Looks right — remove them.

Claude re-runs `remove_duplicates` without `dry_run`. It keeps the first
bookmark in each URL group and removes the rest.

## 5. Reorganize a batch — the safe pattern

Large moves are worth doing deliberately:

1. **Back up first.**
   > **You:** Export all my bookmarks to ~/bookmarks-backup.json
   Claude calls `export_json` with that `file_path`. To restore later, ask Claude
   to import it — `import_json` recreates that tree under a folder you choose
   (default `Other bookmarks`). An `into_path`'s top level must be one of
   `Bookmarks bar`, `Other bookmarks`, or `Mobile bookmarks`.

2. **Preview the moves.** `apply_moves` reads a tab-separated plan with columns
   `id, proposed, current, via, title, url` — one row per bookmark, where
   `proposed` is the destination folder path (or the literal `DELETE?` to drop a
   row when `delete_junk: true`). Each proposed folder path's top level must be
   one of `Bookmarks bar`, `Other bookmarks`, or `Mobile bookmarks` (except the
   literal `DELETE?` when `delete_junk` is used). Only `id` and `proposed` drive
   the action; the rest is human context. See **[sample-plan.tsv](sample-plan.tsv)**
   for a working example.

   **[`tools/classify.py`](../tools/classify.py)** is the starter plan generator:
   it reads Chrome's AccountBookmarks and writes a TSV with those columns — it
   moves nothing. Review the file, then feed it to `apply_moves` (`dry_run`
   first). The script's docstring covers `BOOKMARKS_SRC` / `MOVES_OUT` and
   optional `classify.rules.json`.

   Run with `dry_run: true` first to see counts and targets:

   ```json
   { "dry_run": true, "moved": 3, "deleted": 0, "skipped": 1,
     "distinct_target_folders": 2, "errors": 0 }
   ```

3. **Apply.** Re-run `apply_moves` without `dry_run`. Missing target folders are
   created automatically.

4. **Prune leftovers.**
   > **You:** Remove any now-empty folders (preview first).
   Claude calls `remove_empty_folders` with `dry_run: true`, then for real.

## 6. Search

> **You:** Find my bookmarks about kubernetes.

Claude calls `search_bookmarks` with `query: "kubernetes"` — matches title or
URL and returns each hit with its folder path.

---

### Notes

- **Destructive tools** (`remove_bookmark`, `remove_duplicates`,
  `remove_empty_folders`, `apply_moves`) change your synced bookmarks. The last
  three accept `dry_run: true`. When in doubt, `export_json` first.
- **Folder targeting** accepts either a `*_path` (human-readable, auto-created)
  or a `*_id` from `list_folders`. Paths are easier; ids are exact.
- **Permanent roots** (Bookmarks bar, Other bookmarks, Mobile bookmarks) can't be
  renamed, moved, or deleted — only their contents.
