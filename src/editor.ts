import { escapeXML } from "./xml.ts";
import { encodePath } from "./utils.ts";

/**
 * Renders the full HTML page for the file editor.
 * @param pathname - The full path of the file being edited (e.g. "/docs/notes.txt")
 */
export function renderEditor(pathname: string): string {
    // Extract the filename (basename) and parent directory
    const segments = pathname.split("/").filter(Boolean);
    const filename = segments.pop() || "";
    const parentDir = `/${segments.join("/")}${segments.length ? "/" : ""}`;

    const escapedFilename = escapeXML(filename);
    const pathnameJson = JSON.stringify(pathname);
    const parentDirJson = JSON.stringify(encodePath(parentDir));
    const filenameJson = JSON.stringify(filename);

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Edit ${escapedFilename}</title>
    <style>
      @import url(https://raw.esm.sh/landsoul) layer(landsoul);
      @import url(https://raw.esm.sh/landsoul/dist/extra.css) layer(landsoul);
    </style>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
      .topbar {
        display: flex; align-items: center; gap: 0.5rem;
        padding: 0.5rem 1rem; border-bottom: 1px solid var(--landsoul-border, #ddd);
        flex-shrink: 0; flex-wrap: wrap;
      }
      .topbar a { text-decoration: none; font-size: 1.2rem; padding: 0.2rem 0.4rem; border-radius: 4px; }
      .topbar a:hover { background: var(--landsoul-surface); }
      .topbar input[type="text"] {
        flex: 1; min-width: 150px; font-size: 0.95rem;
        padding: 0.3rem 0.6rem;
      }
      .topbar button { white-space: nowrap; }
      .topbar .save-status {
        font-size: 0.8rem; color: var(--landsoul-text-on-surface);
        min-width: 4rem; text-align: center;
      }
      #editor-container { flex: 1; overflow: hidden; position: relative; }
      .cm-editor { height: 100%; }
      .cm-scroller { overflow: auto; }

      /* loading / error overlay */
      #editor-loading {
        position: absolute; inset: 0; z-index: 2;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 0.75rem; padding: 1rem; text-align: center;
        color: var(--landsoul-text-on-surface);
        background: var(--landsoul-background, #fff);
      }
      #editor-loading .loading-text { font-size: 0.9rem; }
      #editor-loading.error .landsoul-spinner { display: none; }
      #editor-loading.error .loading-text { color: var(--landsoul-danger, #dc2626); }
      #editor-loading .retry-link { font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <div class="topbar">
      <a href="${escapeXML(encodePath(parentDir))}" title="Back to folder">\u2190</a>
      <input type="text" id="filename-input" value="${escapedFilename}" />
      <button id="save-btn" disabled>Save</button>
      <button id="save-close-btn" disabled>Save &amp; Close</button>
      <span class="save-status" id="save-status"></span>
    </div>
    <div id="editor-container">
      <div id="editor-loading">
        <div class="landsoul-spinner" style="--size: 32px" data-size="32px" aria-hidden="true"></div>
        <div class="loading-text">Loading editor\u2026</div>
      </div>
    </div>

    <script type="module">
      const loadingEl = document.getElementById("editor-loading");
      const saveBtn = document.getElementById("save-btn");
      const saveCloseBtn = document.getElementById("save-close-btn");

      function showLoadError(message) {
        if (!loadingEl) return;
        loadingEl.classList.add("error");
        loadingEl.innerHTML =
          '<div class="loading-text">' + message + '</div>' +
          '<a class="retry-link" href="#" onclick="location.reload();return false;">Retry</a>';
      }

      let PATHNAME = ${pathnameJson};
      const PARENT_DIR = ${parentDirJson};
      let ORIGINAL_FILENAME = ${filenameJson};

      let view;

      // Fetch file content
      async function loadContent() {
        try {
          const r = await fetch(PATHNAME);
          if (!r.ok) return "";
          return await r.text();
        } catch {
          return "";
        }
      }

      // esm.sh import can take a few seconds
      let EditorView, basicSetup, EditorState, languages;
      try {
        [{ EditorView, basicSetup }, { EditorState }, { languages }] = await Promise.all([
          import("https://esm.sh/codemirror"),
          import("https://esm.sh/@codemirror/state"),
          import("https://esm.sh/@codemirror/language-data"),
        ]);
      } catch (err) {
        showLoadError("Failed to load the editor. Check your connection and try again.");
        throw err;
      }

      const content = await loadContent();

      // Load language support based on file extension
      const extensions = [basicSetup];
      const ext = ORIGINAL_FILENAME.split(".").pop()?.toLowerCase();
      const lang = ext && languages.find(l => l.extensions.includes(ext) || (l.filename && l.filename.test(ORIGINAL_FILENAME)));
      if (lang) {
        try {
          const support = await lang.load();
          extensions.push(support);
        } catch {
          // highlighting optional
        }
      }

      // Initialize CodeMirror
      view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions,
        }),
        parent: document.getElementById("editor-container"),
      });

      // ready
      loadingEl?.remove();
      saveBtn.disabled = false;
      saveCloseBtn.disabled = false;
      view.focus();

      function showStatus(msg) {
        const el = document.getElementById("save-status");
        el.textContent = msg;
        setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
      }

      async function save() {
        const newName = document.getElementById("filename-input").value.trim();
        if (!newName) { alert("Filename cannot be empty"); return false; }

        let currentPath = PATHNAME;

        // Rename if filename changed
        if (newName !== ORIGINAL_FILENAME) {
          const newPath = PARENT_DIR + encodeURIComponent(newName);
          const r = await fetch(currentPath, {
            method: "MOVE",
            headers: { "Destination": location.origin + newPath },
          });
          if (r.status === 401) { window.location.reload(); return false; }
          if (!r.ok && r.status !== 201 && r.status !== 204) {
            alert("Rename failed: " + r.status + " " + await r.text());
            return false;
          }
          currentPath = newPath;
          PATHNAME = newPath;
          ORIGINAL_FILENAME = newName;
          history.replaceState(null, "", currentPath + "?edit");
        }

        // Save content
        const body = view.state.doc.toString();
        const r = await fetch(currentPath, { method: "PUT", body });
        if (r.status === 401) { window.location.reload(); return false; }
        if (!r.ok && r.status !== 201) {
          alert("Save failed: " + r.status + " " + await r.text());
          return false;
        }

        showStatus("Saved");
        return true;
      }

      saveBtn.addEventListener("click", async () => {
        await save();
      });

      saveCloseBtn.addEventListener("click", async () => {
        const ok = await save();
        if (ok) window.location.href = PARENT_DIR;
      });

      // Ctrl+S / Cmd+S shortcut
      document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          save();
        }
      });
    </script>
  </body>
</html>`;
}
