import type { Dirent } from "node:fs";
import type { FsSubset } from "./abstract.ts";
import { escapeXML } from "./utils.ts";

interface EntryInfo {
    name: string;
    isDir: boolean;
    size: number;
    mtime: Date;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDate(d: Date): string {
    if (d.getTime() === 0) return "—";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildBreadcrumb(pathname: string): string {
    const segments = pathname.split("/").filter(Boolean);
    const parts: string[] = [`<a href="/">~</a>`];
    let accumulated = "";
    for (const seg of segments) {
        accumulated += `/${seg}`;
        parts.push(`<span aria-hidden="true">/</span><a href="${encodeURI(accumulated + "/")}">${escapeXML(seg)}</a>`);
    }
    return parts.join("");
}

// Inline SVGs avoid per-row network requests to iconify.design
const ICON_FOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="entry-icon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
const ICON_FILE = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="entry-icon"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const ICON_UP = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="entry-icon"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`;
const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`;
const ICON_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;

function buildRow(entry: EntryInfo, pathname: string): string {
    const fullPath = pathname + entry.name + (entry.isDir ? "/" : "");
    const href = `./${encodeURIComponent(entry.name)}${entry.isDir ? "/" : ""}`;
    const escapedName = escapeXML(entry.name);
    const escapedPath = escapeXML(fullPath);
    const formattedDate = formatDate(entry.mtime);
    const formattedSize = entry.isDir ? "" : formatSize(entry.size);
    const displayName = escapedName + (entry.isDir ? "/" : "");

    return `<li class="file-row">
      <a class="row-link" href="${href}" aria-label="${escapedName}"></a>
      <span class="row-inner">
        <span class="name">${entry.isDir ? ICON_FOLDER : ICON_FILE}<span class="name-inner"><span class="name-text">${displayName}</span><span class="meta-sub">${formattedDate}${entry.isDir ? "" : `<span class="meta-sub-sep">·</span><span class="meta-sub-size">${formattedSize}</span>`}</span></span></span>
        <span class="meta-size">${formattedSize}</span>
        <span class="meta-date">${formattedDate}</span>
        <span class="actions">
          ${entry.isDir ? `<a class="download-btn btn-placeholder" aria-hidden="true">${ICON_DOWNLOAD}</a>` : `<a class="download-btn" href="${href}" download title="Download">${ICON_DOWNLOAD}</a>`}
          <button class="rename-btn" data-path="${escapedPath}" data-isdir="${entry.isDir ? "1" : "0"}" title="Rename">${ICON_PENCIL}</button>
          <button class="delete-btn" data-path="${escapedPath}" title="Delete">${ICON_TRASH}</button>
        </span>
      </span>
    </li>`;
}

export async function renderManager(fs: FsSubset, pathname: string, dir: string, files: Dirent[]): Promise<string> {
    const normalizedPathname = pathname.endsWith("/") ? pathname : pathname + "/";

    const entries: EntryInfo[] = await Promise.all(
        files.map(async (entry) => {
            const entryPath = normalizedPathname + entry.name;
            let size = 0;
            let mtime = new Date(0);
            try {
                const stat = await fs.stat(entryPath);
                size = stat.size;
                mtime = stat.mtime;
            } catch {
                // entry disappeared between readdir and stat
            }
            return { name: entry.name, isDir: entry.isDirectory(), size, mtime };
        }),
    );

    entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    const rows = entries.map((e) => buildRow(e, normalizedPathname)).join("\n");
    const parentRow =
        normalizedPathname !== "/"
            ? `<li class="file-row parent-row">
      <a class="row-link" href="../" aria-label="Parent directory"></a>
      <span class="row-inner">
        <span class="name">${ICON_UP}<span class="name-inner"><span class="name-text">../</span></span></span>
        <span class="meta-size"></span>
        <span class="meta-date"></span>
        <span class="actions">
          <a class="download-btn btn-placeholder" aria-hidden="true">${ICON_DOWNLOAD}</a>
          <button class="rename-btn btn-placeholder" disabled></button>
          <button class="delete-btn btn-placeholder" disabled></button>
        </span>
      </span>
    </li>`
            : "";
    const breadcrumb = buildBreadcrumb(normalizedPathname);
    const pathnameJson = JSON.stringify(normalizedPathname);

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeXML(dir)} — wedbav</title>
    <style>
      @import url(https://cdn.jsdelivr.net/npm/landsoul) layer(landsoul);
      @import url(https://cdn.jsdelivr.net/npm/landsoul/dist/extra.css) layer(landsoul);
    </style>
    <style>
      body { max-width: 860px; margin: 0 auto; padding: 2rem 1.25rem; }

      .breadcrumb {
        display: flex; align-items: center; gap: 0.2rem;
        font-size: 1rem; font-weight: 500;
        color: var(--landsoul-text-on-surface); margin-bottom: 1.5rem; flex-wrap: wrap;
        overflow: hidden; word-break: break-all;
      }
      .breadcrumb a { text-decoration: none; color: var(--landsoul-text-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
      .breadcrumb a:last-child { color: var(--landsoul-text); font-weight: 600; }
      .breadcrumb a:not(:last-child):hover { color: var(--landsoul-accent); }
      .breadcrumb span { margin: 0 0.1rem; opacity: 0.35; flex-shrink: 0; }

      .toolbar { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.25rem; align-items: stretch; }
      .toolbar fieldset { display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.75rem; margin: 0; }
      .toolbar fieldset legend { font-size: 0.75rem; padding: 0 0.2rem; }
      .toolbar input[type="file"] { max-width: 180px; padding: 0; }
      .toolbar input[type="text"] { width: 150px; }
      @media (max-width: 560px) {
        .toolbar input[type="file"] { max-width: 130px; }
        .toolbar input[type="text"] { width: 110px; }
      }

      .file-list { margin: 0; }
      .file-list .file-row .row-inner { display: grid; grid-template-columns: 1fr 4.5rem 9rem auto; align-items: center; column-gap: 0.75rem; width: 100%; min-width: 0; }
      .file-list .file-row { position: relative; }
      .file-list .row-link { position: absolute; inset: 0; z-index: 0; border-radius: inherit; }
      .file-list .name { min-width: 0; overflow: hidden; pointer-events: none; display: flex; align-items: center; gap: 0.4rem; }
      .file-list .name-inner { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
      .file-list .name-text { color: var(--landsoul-accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .file-list .parent-row .name > span { color: var(--landsoul-accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .file-list .meta-sub { display: none; }
      .entry-icon { width: 1em; height: 1em; flex-shrink: 0; opacity: 0.45; }
      .file-list .meta-size, .file-list .meta-date {
        white-space: nowrap; font-size: 0.8rem;
        color: var(--landsoul-text-on-surface);
        position: relative; z-index: 1;
        font-variant-numeric: tabular-nums;
      }
      .file-list .meta-size { text-align: right; }
      .file-list .meta-date { text-align: right; }
      @media (max-width: 560px) {
        .file-list .file-row .row-inner { grid-template-columns: 1fr auto; }
        .file-list .actions { align-self: center; }
        .file-list .meta-size, .file-list .meta-date { display: none; }
        .file-list .meta-sub { display: flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; color: var(--landsoul-text-on-surface); font-variant-numeric: tabular-nums; }
        .file-list .meta-sub-sep { opacity: 0.35; margin: 0 0.25rem; }
        .file-list .meta-sub-size { opacity: 0.6; }
      }

      .file-list .actions {
        display: inline-flex; gap: 0.25rem; flex-shrink: 0;
        visibility: hidden; position: relative; z-index: 1;
      }
      .file-list .actions .btn-placeholder { visibility: hidden; pointer-events: none; }
      .file-list .file-row:hover .actions,
      .file-list .file-row:focus-within .actions { visibility: visible; }
      .file-list .actions button, .file-list .actions a.download-btn {
        all: unset; cursor: pointer; padding: 0.2rem;
        border-radius: 4px; display: flex; align-items: center;
        transition: background 0.1s;
      }
      .file-list .actions button:hover, .file-list .actions a.download-btn:hover { background: var(--landsoul-surface); }
      .file-list .actions button svg, .file-list .actions a.download-btn svg { width: 1rem; height: 1rem; opacity: 0.5; }
      .file-list .actions button:hover svg, .file-list .actions a.download-btn:hover svg { opacity: 0.85; }
      .file-list .actions .delete-btn svg { color: var(--landsoul-danger); opacity: 0.7; }
      .file-list .actions .delete-btn:hover svg { opacity: 1; }


      #delete-dialog, #rename-dialog { width: 380px; max-width: calc(100vw - 2rem); padding: 1.5rem; box-sizing: border-box; }
      #delete-dialog > *:first-child, #rename-dialog > *:first-child { margin-top: 0; }
      #delete-dialog menu, #rename-dialog menu { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 0; margin: 1.25rem 0 0; }
      #delete-target-path { font-size: 0.8rem; color: var(--landsoul-text-on-surface); word-break: break-all; margin-top: 0.25rem; }
      #delete-dialog p strong, #rename-dialog p strong { word-break: break-all; }
      #rename-dialog label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--landsoul-text-on-surface); }
      #rename-dialog label input { width: 100%; box-sizing: border-box; font-size: 1rem; color: var(--landsoul-text); }
      .btn-danger { background: var(--landsoul-danger) !important; color: var(--landsoul-inverse-text) !important; border-color: var(--landsoul-danger) !important; }
      .btn-accent { background: var(--landsoul-accent) !important; color: var(--landsoul-inverse-text) !important; border-color: var(--landsoul-accent) !important; }
    </style>
  </head>
  <body>
    <nav class="breadcrumb">${breadcrumb}</nav>

    <div class="toolbar">
      <fieldset>
        <legend>Upload</legend>
        <input type="file" id="upload-input" multiple />
        <button id="upload-btn">Upload</button>
        <button id="upload-spinner" class="landsoul-spinner" style="display:none" disabled></button>
      </fieldset>
      <fieldset>
        <legend>New Folder</legend>
        <input type="text" id="mkdir-name" placeholder="Folder name" />
        <button id="mkdir-btn">Create</button>
      </fieldset>
    </div>

    <ul id="file-list" class="file-list landsoul-list">
      ${parentRow}
      ${rows}
    </ul>

    <dialog id="delete-dialog">
      <p>Delete <strong id="delete-target-name"></strong>?</p>
      <p id="delete-target-path"></p>
      <menu>
        <button id="delete-confirm-btn" class="btn-danger">Delete</button>
        <button id="delete-cancel-btn">Cancel</button>
      </menu>
    </dialog>

    <dialog id="rename-dialog">
      <p>Rename <strong id="rename-old-name"></strong></p>
      <label>
        New name
        <input type="text" id="rename-input" />
      </label>
      <menu>
        <button id="rename-confirm-btn" class="btn-accent">Rename</button>
        <button id="rename-cancel-btn">Cancel</button>
      </menu>
    </dialog>

    <script>
      const PATHNAME = ${pathnameJson};

      function lastName(path) {
        return path.split("/").filter(Boolean).pop() || path;
      }

      document.getElementById("file-list").addEventListener("click", function(e) {
        const btn = e.target.closest("button");
        if (!btn) return;
        if (btn.classList.contains("delete-btn")) openDeleteDialog(btn.dataset.path);
        if (btn.classList.contains("rename-btn")) openRenameDialog(btn.dataset.path, btn.dataset.isdir === "1");
      });

      let _deletePath = null;
      function openDeleteDialog(path) {
        _deletePath = path;
        document.getElementById("delete-target-name").textContent = lastName(path);
        document.getElementById("delete-target-path").textContent = path;
        document.getElementById("delete-dialog").showModal();
      }
      document.getElementById("delete-confirm-btn").addEventListener("click", async () => {
        if (!_deletePath) return;
        document.getElementById("delete-dialog").close();
        const r = await fetch(_deletePath, { method: "DELETE" });
        if (r.ok || r.status === 204) location.reload();
        else alert("Delete failed: " + r.status + " " + await r.text());
      });
      document.getElementById("delete-cancel-btn").addEventListener("click", () => document.getElementById("delete-dialog").close());

      let _renamePath = null, _renameIsDir = false;
      function openRenameDialog(oldPath, isDir) {
        _renamePath = oldPath;
        _renameIsDir = isDir;
        const oldName = lastName(oldPath);
        document.getElementById("rename-old-name").textContent = oldName;
        const input = document.getElementById("rename-input");
        input.value = oldName;
        document.getElementById("rename-dialog").showModal();
        input.select();
      }
      async function doRename() {
        const newName = document.getElementById("rename-input").value.trim();
        const oldName = lastName(_renamePath);
        document.getElementById("rename-dialog").close();
        if (!newName || newName === oldName) return;
        const newPath = PATHNAME + encodeURIComponent(newName) + (_renameIsDir ? "/" : "");
        const r = await fetch(_renamePath, { method: "MOVE", headers: { "Destination": location.origin + newPath } });
        if (r.ok || r.status === 201 || r.status === 204) location.reload();
        else alert("Rename failed: " + r.status + " " + await r.text());
      }
      document.getElementById("rename-confirm-btn").addEventListener("click", doRename);
      document.getElementById("rename-cancel-btn").addEventListener("click", () => document.getElementById("rename-dialog").close());
      document.getElementById("rename-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doRename(); });

      async function createDir() {
        const name = document.getElementById("mkdir-name").value.trim();
        if (!name) return;
        const r = await fetch(PATHNAME + encodeURIComponent(name) + "/", { method: "MKCOL" });
        if (r.ok || r.status === 201) location.reload();
        else alert("Create directory failed: " + r.status + " " + await r.text());
      }
      document.getElementById("mkdir-btn").addEventListener("click", createDir);
      document.getElementById("mkdir-name").addEventListener("keydown", (e) => { if (e.key === "Enter") createDir(); });

      async function uploadFiles() {
        const input = document.getElementById("upload-input");
        if (!input.files.length) return;
        const btn = document.getElementById("upload-btn");
        const spinner = document.getElementById("upload-spinner");
        btn.style.display = "none";
        spinner.style.display = "";
        const results = await Promise.all(
          Array.from(input.files).map((file) =>
            fetch(PATHNAME + encodeURIComponent(file.name), { method: "PUT", body: file })
          )
        );
        spinner.style.display = "none";
        btn.style.display = "";
        const failed = results.filter((r) => !r.ok && r.status !== 201).length;
        if (failed) alert(failed + " upload(s) failed.");
        else location.reload();
      }
      document.getElementById("upload-btn").addEventListener("click", uploadFiles);
    </script>
  </body>
</html>`;
}
