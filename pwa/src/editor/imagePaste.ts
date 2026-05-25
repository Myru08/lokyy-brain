import { EditorView } from "@codemirror/view";
import { api } from "../api.js";

/**
 * Image-Paste + Drag-Drop Extension.
 *
 * Verhalten:
 *   - Auf `paste` Events werden Bilder aus dem System-Clipboard
 *     erkannt (`clipboardData.items` mit `type.startsWith("image/")`).
 *   - Auf `drop` Events werden Bild-Dateien aus dem OS-Filemanager
 *     erkannt (`dataTransfer.files`).
 *   - Pro Bild wird sofort ein Platzhalter `![uploading...](#)` an die
 *     aktuelle Caret-Position eingefügt — der Editor bleibt responsiv.
 *   - Im Hintergrund läuft `api.uploadAsset` → sobald die URL da ist,
 *     wird der Platzhalter per Transaktion durch `![](URL)\n` ersetzt.
 *   - Bei Fehler wird der Platzhalter zu `⚠ upload failed`.
 *
 * Pro Bild eindeutiger Platzhalter (Token-Suffix), damit parallele
 * Uploads sich nicht gegenseitig den falschen Range patchen.
 */

let placeholderCounter = 0;

function nextPlaceholderToken(): string {
  placeholderCounter += 1;
  // ​ (ZWSP) macht den Token unsichtbar und kollidiert nicht mit
  // markdown-Syntax — der String ist trotzdem stabil und eindeutig.
  return `​${placeholderCounter}​`;
}

/**
 * Sucht im Doc nach `text` und ersetzt das erste Vorkommen mit
 * `replacement`. Tut nichts, wenn der Platzhalter nicht mehr da ist
 * (Nutzer hat ihn gelöscht oder mehrere Uploads kollidiert).
 */
function replaceFirst(view: EditorView, text: string, replacement: string) {
  const doc = view.state.doc.toString();
  const idx = doc.indexOf(text);
  if (idx < 0) return;
  view.dispatch({
    changes: { from: idx, to: idx + text.length, insert: replacement },
  });
}

/** Fügt einen Text am aktuellen Caret ein, gibt den eingefügten String zurück. */
function insertAtCursor(view: EditorView, insert: string): void {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  });
}

/**
 * Lädt eine Datei hoch und tauscht den Placeholder. Errors landen ohne
 * Re-Throw im Editor — der Caller (DOM-Handler) muss synchron `true`
 * zurückgeben können.
 */
async function uploadAndReplace(view: EditorView, file: File): Promise<void> {
  const token = nextPlaceholderToken();
  const placeholder = `![uploading${token}](#)`;
  insertAtCursor(view, placeholder);

  try {
    const { url } = await api.uploadAsset(file);
    replaceFirst(view, placeholder, `![](${url})\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "upload failed";
    replaceFirst(view, placeholder, `⚠ upload failed: ${msg}`);
  }
}

function collectClipboardImages(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

function collectDropImages(event: DragEvent): File[] {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return [];
  const out: File[] = [];
  for (const f of Array.from(files)) {
    if (f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

/**
 * CodeMirror-Extension. Im `extensions`-Array des Editors einhängen.
 * Hat keine Decorations, nur DOM-Event-Handler.
 */
export const imagePasteExtension = EditorView.domEventHandlers({
  paste(event, view) {
    const images = collectClipboardImages(event);
    if (images.length === 0) return false;
    event.preventDefault();
    for (const file of images) {
      void uploadAndReplace(view, file);
    }
    return true;
  },
  drop(event, view) {
    const images = collectDropImages(event);
    if (images.length === 0) return false;
    event.preventDefault();
    // Caret auf Drop-Position setzen, damit das Bild dort landet, wo der
    // Nutzer es fallen gelassen hat — sonst landet es am alten Cursor.
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) {
      view.dispatch({ selection: { anchor: pos } });
    }
    for (const file of images) {
      void uploadAndReplace(view, file);
    }
    return true;
  },
});
