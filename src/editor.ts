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
      @import url(https://cdn.jsdelivr.net/npm/landsoul) layer(landsoul);
      @import url(https://cdn.jsdelivr.net/npm/landsoul/dist/extra.css) layer(landsoul);
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
      #editor-container { flex: 1; overflow: hidden; }
      .cm-editor { height: 100%; }
      .cm-scroller { overflow: auto; }
    </style>
  </head>
  <body>
    <div class="topbar">
      <a href="${escapeXML(encodePath(parentDir))}" title="Back to folder">\u2190</a>
      <input type="text" id="filename-input" value="${escapedFilename}" />
      <button id="save-btn">Save</button>
      <button id="save-close-btn">Save &amp; Close</button>
      <span class="save-status" id="save-status"></span>
    </div>
    <div id="editor-container"></div>

    <script type="module">
      import { EditorView, basicSetup } from "https://esm.sh/codemirror";
      import { EditorState } from "https://esm.sh/@codemirror/state";

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

      const content = await loadContent();

      // Initialize CodeMirror
      view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [basicSetup],
        }),
        parent: document.getElementById("editor-container"),
      });

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

      document.getElementById("save-btn").addEventListener("click", async () => {
        await save();
      });

      document.getElementById("save-close-btn").addEventListener("click", async () => {
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
