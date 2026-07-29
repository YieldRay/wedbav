import { encodePath } from "./utils.ts";
import { escapeXML } from "./xml.ts";

/**
 * Renders the full HTML page for the file editor.
 * @param pathname - The full path of the file being edited (e.g. "/docs/notes.txt")
 * @param actionQuery - The query-string key that activates actions (default "action");
 *   the editor is reached via `?<actionQuery>=edit`.
 */
export function renderEditor(pathname: string, actionQuery = "action"): string {
  // Extract the filename (basename) and parent directory
  const segments = pathname.split("/").filter(Boolean);
  const filename = segments.pop() || "";
  const parentDir = `/${segments.join("/")}${segments.length ? "/" : ""}`;

  const escapedFilename = escapeXML(filename);
  const pathnameJson = JSON.stringify(pathname);
  const parentDirJson = JSON.stringify(encodePath(parentDir));
  const filenameJson = JSON.stringify(filename);
  const actionQueryJson = JSON.stringify(encodeURIComponent(actionQuery));

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
        padding: 0.5rem 1rem; border-bottom: 1px solid var(--landsoul-border);
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
        background: var(--landsoul-background);
      }
      #editor-loading .loading-text { font-size: 0.9rem; }
      #editor-loading.error .landsoul-spinner { display: none; }
      #editor-loading.error .loading-text { color: var(--landsoul-danger); }
      #editor-loading .retry-link { font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <div class="topbar">
      <a href="${escapeXML(encodePath(parentDir))}" title="Back to folder">←</a>
      <input type="text" id="filename-input" value="${escapedFilename}" />
      <button id="save-btn" disabled>Save</button>
      <button id="save-close-btn" disabled>Save &amp; Close</button>
      <span class="save-status" id="save-status"></span>
    </div>
    <div id="editor-container">
      <div id="editor-loading">
        <div class="landsoul-spinner" style="--size: 32px" data-size="32px" aria-hidden="true"></div>
        <div class="loading-text">Loading editor…</div>
      </div>
    </div>

    <script type="module">
      const loadingEl = document.getElementById("editor-loading");
      const saveBtn = document.getElementById("save-btn");
      const saveCloseBtn = document.getElementById("save-close-btn");

      function showLoadError(message) {
        if (!loadingEl) return;
        loadingEl.classList.add("error");
        loadingEl.replaceChildren(
          Object.assign(document.createElement("div"), {
            className: "loading-text",
            textContent: message,
          }),
          Object.assign(document.createElement("a"), {
            className: "retry-link",
            href: "#",
            textContent: "Retry",
            onclick: () => { location.reload(); return false; },
          }),
        );
      }

      function showAlert(content, title, lightDismiss = true) {
        const openElement = (element) => {
          if (lightDismiss) element.showPopover();
          else element.showModal();
        };
        const closeElement = (element) => {
          if (lightDismiss) element.hidePopover();
          else element.close();
        };
        const dialog = Object.assign(document.createElement("dialog"), { popover: "auto" });
        document.body.appendChild(dialog);
        const header = title
          ? Object.assign(document.createElement("header"), {
              textContent: title,
              style: "font-weight: bold",
            })
          : null;
        const body = Object.assign(document.createElement("section"), {
          textContent: content,
          style: "margin-top: 8px",
        });
        const ok = Object.assign(document.createElement("button"), {
          textContent: "OK",
          onclick: () => closeElement(dialog),
          style: "margin-top: 8px;width:100%",
        });
        const footer = Object.assign(document.createElement("footer"), {});

        openElement(dialog);
        footer.appendChild(ok);
        if (header) dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(footer);
      }

      let PATHNAME = ${pathnameJson};
      const PARENT_DIR = ${parentDirJson};
      let ORIGINAL_FILENAME = ${filenameJson};
      const ACTION_QUERY = ${actionQueryJson};

      let view;

      // Fetch file content. cache: "no-store" bypasses the browser HTTP cache so
      // we never load a stale copy (which would otherwise be written back on save).
      async function loadContent() {
        try {
          const r = await fetch(PATHNAME, { cache: "no-store" });
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

      // Show a status message. When 'persist' is true (e.g. "Saving…") the
      // message stays until it's replaced; otherwise it auto-clears after 3s.
      function showStatus(msg, persist) {
        const el = document.getElementById("save-status");
        el.textContent = msg;
        if (persist) return;
        setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
      }

      async function save() {
        const newName = document.getElementById("filename-input").value.trim();
        if (!newName) { showAlert("Filename cannot be empty.", "Invalid filename"); return false; }

        // Indicate that a save is in progress and lock the buttons.
        showStatus("Saving…", true);
        saveBtn.disabled = true;
        saveCloseBtn.disabled = true;

        try {
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
              showStatus("Save failed");
              showAlert(r.status + " " + await r.text(), "Rename failed");
              return false;
            }
            currentPath = newPath;
            PATHNAME = newPath;
            ORIGINAL_FILENAME = newName;
            history.replaceState(null, "", currentPath + "?" + ACTION_QUERY + "=edit");
          }

          // Save content
          const body = view.state.doc.toString();
          const r = await fetch(currentPath, { method: "PUT", body });
          if (r.status === 401) { window.location.reload(); return false; }
          if (!r.ok && r.status !== 201) {
            showStatus("Save failed");
            showAlert(r.status + " " + await r.text(), "Save failed");
            return false;
          }

          showStatus("Saved");
          return true;
        } catch (err) {
          showStatus("Save failed");
          showAlert(String(err), "Save failed");
          return false;
        } finally {
          saveBtn.disabled = false;
          saveCloseBtn.disabled = false;
        }
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
