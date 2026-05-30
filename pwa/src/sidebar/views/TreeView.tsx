import { useCallback, useEffect, useRef, useState } from "react";
import type { TreeNode } from "@lokyy/shared";
import { FileTree, type FileTreeHandle } from "../../FileTree.js";
import { api } from "../../api.js";
import { C, FONT } from "../../theme.js";
import type { ViewProps } from "./registry.js";

/**
 * TreeView — echter Renderer für `viewType: "tree"` (Story 11.4).
 *
 * Umhüllt die bestehende `FileTree`-Logik mit einem `folder`-Scope aus dem
 * Menüpunkt (`item.folder`) und reicht Notiz-Öffnungen über `onOpenNote`
 * (→ `App.open()`) durch. `FileTree.tsx` wird dabei NICHT verändert oder
 * ersetzt — nur wiederverwendet/komponiert (Addendum §2).
 *
 * Scope-Regel:
 *   - `item.folder === ""`  → ganzer Vault-Baum (Root).
 *   - `item.folder === "X"` → nur der Teilbaum unter "X" (dessen Kinder).
 *
 * State: TreeView hält ausschließlich seinen eigenen, gescopten Baum (Fetch +
 * Refresh nach Mutationen). Routing/Editor-State bleibt in `App.tsx` — wir
 * reichen nur `onOpenNote` durch (kein eigener „active note"-State, kein
 * eigener Router).
 *
 * [Source: epic-11-architecture-addendum.md §2; epic-11 Story 11.4 AC 3]
 */

/**
 * Findet den Knoten zu einem Vault-relativen Ordnerpfad und gibt dessen
 * Kinder zurück. "" → der gesamte Baum (Root). Unbekannter Pfad → `null`
 * (Aufrufer rendert dann einen leeren-Scope-Hinweis).
 */
function scopeToFolder(
  tree: TreeNode[],
  folder: string,
): TreeNode[] | null {
  if (!folder) return tree;
  const stack: TreeNode[] = [...tree];
  while (stack.length > 0) {
    const node = stack.shift() as TreeNode;
    if (node.type === "folder" && node.path === folder) {
      return node.children;
    }
    if (node.children.length > 0) stack.push(...node.children);
  }
  return null;
}

/** "a/b/c" → "a/b" ; "a" → "" (gespiegelt aus FileTree-Konvention). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Dateiname-Sanitizing analog zur App: harte Pfad-Trenner raus. */
function safeName(name: string): string {
  return name.replace(/[\\/]/g, "").trim();
}

export function TreeView({ item, onOpenNote }: ViewProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const fileTreeRef = useRef<FileTreeHandle | null>(null);

  const refreshTree = useCallback(async () => {
    try {
      const next = await api.tree();
      setTree(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Baum konnte nicht geladen werden");
    }
  }, []);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  /**
   * Öffnen delegiert nach oben in `App.open()`. Wir merken die aktive id nur
   * lokal, damit FileTree die Zeile hervorheben kann — die Wahrheit über die
   * geöffnete Notiz bleibt in `App.tsx`.
   */
  const handleOpen = useCallback(
    (id: string) => {
      setActiveId(id);
      onOpenNote(id);
    },
    [onOpenNote],
  );

  const handleCreate = useCallback(
    async (parentPath: string, name: string, kind: "note" | "folder") => {
      const clean = safeName(name);
      if (!clean) return;
      const path = parentPath ? `${parentPath}/${clean}` : clean;
      try {
        if (kind === "folder") {
          await api.createFolder(path);
          await refreshTree();
        } else {
          const note = await api.createNote(path);
          await refreshTree();
          handleOpen(note.id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Anlegen fehlgeschlagen");
      }
    },
    [refreshTree, handleOpen],
  );

  const handleRename = useCallback(
    async (node: TreeNode, newName: string) => {
      const clean = safeName(newName);
      if (!clean) return;
      const parent = parentOf(node.path);
      const to = parent ? `${parent}/${clean}` : clean;
      if (to === node.path) return;
      try {
        await api.move(node.path, to, node.type);
        await refreshTree();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Umbenennen fehlgeschlagen");
      }
    },
    [refreshTree],
  );

  const handleMove = useCallback(
    async (node: TreeNode, targetFolderPath: string) => {
      const base = node.path.slice(node.path.lastIndexOf("/") + 1);
      const to = targetFolderPath ? `${targetFolderPath}/${base}` : base;
      if (to === node.path) return;
      try {
        await api.move(node.path, to, node.type);
        await refreshTree();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Verschieben fehlgeschlagen");
      }
    },
    [refreshTree],
  );

  const handleDelete = useCallback(
    async (node: TreeNode) => {
      try {
        await api.remove(node.path, node.type);
        await refreshTree();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Löschen fehlgeschlagen");
      }
    },
    [refreshTree],
  );

  const scoped = scopeToFolder(tree, item.folder);

  if (error) {
    return (
      <div
        style={{
          padding: "16px",
          color: C.err,
          fontFamily: FONT.mono,
          fontSize: 12,
        }}
      >
        {error}
      </div>
    );
  }

  if (scoped === null) {
    // Der konfigurierte Ordner existiert (noch) nicht im Vault — kein Crash,
    // nur ein Hinweis. Das spiegelt das defensive Read-Verhalten in core.
    return (
      <div
        style={{
          padding: "16px",
          color: C.textFaint,
          fontFamily: FONT.mono,
          fontSize: 12,
        }}
      >
        Ordner „{item.folder}" nicht gefunden
      </div>
    );
  }

  return (
    <FileTree
      ref={fileTreeRef}
      tree={scoped}
      activeId={activeId}
      onOpen={handleOpen}
      onCreate={handleCreate}
      onRename={handleRename}
      onMove={handleMove}
      onDelete={handleDelete}
    />
  );
}
