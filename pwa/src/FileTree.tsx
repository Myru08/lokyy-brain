import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { TreeNode } from "@lokyy/shared";
import {
  ChevronRight,
  File,
  Folder,
  FolderPlus,
  FilePlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { C, FONT } from "./theme.js";

/**
 * Datei-Baum. Bildet die Ordnerstruktur des Vaults ab und kann sie
 * verändern: anlegen, umbenennen, verschieben (Drag & Drop), löschen.
 *
 * Die Komponente kümmert sich nur um die UX (Aufklappen, Inline-Eingabe,
 * Drag-State). Die eigentlichen Operationen — und das anschließende
 * Neuladen des Baums — macht die App über die `on*`-Callbacks.
 */

interface FileTreeProps {
  tree: TreeNode[];
  activeId: string | null;
  onOpen: (id: string) => void;
  /** parentPath "" = Vault-Root */
  onCreate: (parentPath: string, name: string, kind: "note" | "folder") => void;
  onRename: (node: TreeNode, newName: string) => void;
  onMove: (node: TreeNode, targetFolderPath: string) => void;
  onDelete: (node: TreeNode) => void;
  /**
   * Wenn gesetzt: zeige nur Notizen, deren id in dieser Menge ist
   * (Ordner werden mitgerendert, sofern sie mindestens eine gefilterte
   * Notiz enthalten). null/undefined = kein Filter.
   */
  tagFilteredNoteIds?: Set<string> | null;
}

/**
 * Recursive prune: drop note-children not in `keep`, drop folders that
 * become empty after pruning their subtree.
 */
function pruneTree(nodes: TreeNode[], keep: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "note") {
      if (keep.has(n.path)) out.push(n);
    } else {
      const kids = pruneTree(n.children, keep);
      if (kids.length > 0) {
        out.push({ ...n, children: kids });
      }
    }
  }
  return out;
}

type Editing =
  | { mode: "rename"; path: string }
  | { mode: "new-note" | "new-folder"; parentPath: string }
  | null;

/** "pai/sub/hermes" -> "pai/sub" ; "hermes" -> "" */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function FileTree({
  tree,
  activeId,
  onOpen,
  onCreate,
  onRename,
  onMove,
  onDelete,
  tagFilteredNoteIds,
}: FileTreeProps) {
  const visibleTree = tagFilteredNoteIds
    ? pruneTree(tree, tagFilteredNoteIds)
    : tree;
  // offene Ordner; Root-Kinder starten eingeklappt
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragged = useRef<TreeNode | null>(null);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  function commitEdit(value: string) {
    const name = value.trim();
    const e = editing;
    setEditing(null);
    if (!name) return;
    if (e?.mode === "rename") {
      // Node aus dem Baum suchen, um Kind (note/folder) zu kennen
      const node = findNode(tree, e.path);
      if (node && name !== node.name) onRename(node, name);
    } else if (e?.mode === "new-note") {
      onCreate(e.parentPath, name, "note");
    } else if (e?.mode === "new-folder") {
      onCreate(e.parentPath, name, "folder");
    }
  }

  return (
    <div style={{ fontFamily: FONT.ui, userSelect: "none" }}>
      {/* Kopf: Root-Aktionen */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 6px 8px",
          gap: 4,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: C.gold,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            flex: 1,
          }}
        >
          VAULT
        </span>
        <IconButton
          title="Neue Notiz"
          onClick={() => setEditing({ mode: "new-note", parentPath: "" })}
        >
          <FilePlus size={18} />
        </IconButton>
        <IconButton
          title="Neuer Ordner"
          onClick={() => setEditing({ mode: "new-folder", parentPath: "" })}
        >
          <FolderPlus size={18} />
        </IconButton>
      </div>

      {/* Root-Ebene als Drop-Ziel (verschieben in den Vault-Root) */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget("");
        }}
        onDragLeave={() => setDropTarget((t) => (t === "" ? null : t))}
        onDrop={() => {
          if (dragged.current && parentOf(dragged.current.path) !== "") {
            onMove(dragged.current, "");
          }
          dragged.current = null;
          setDropTarget(null);
        }}
        style={{
          minHeight: 40,
          borderRadius: 6,
          outline:
            dropTarget === "" ? `1px dashed ${C.accent}` : "1px solid transparent",
        }}
      >
        {/* Inline-Eingabe für neue Root-Einträge */}
        {editing && "parentPath" in editing && editing.parentPath === "" && (
          <InlineInput
            depth={0}
            kind={editing.mode === "new-folder" ? "folder" : "note"}
            onCommit={commitEdit}
            onCancel={() => setEditing(null)}
          />
        )}

        {visibleTree.map((node) => (
          <Row
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            editing={editing}
            activeId={activeId}
            dropTarget={dropTarget}
            onToggle={toggle}
            onOpen={onOpen}
            onStartEdit={setEditing}
            onCommitEdit={commitEdit}
            onCancelEdit={() => setEditing(null)}
            onDelete={onDelete}
            onDragStart={(n) => (dragged.current = n)}
            onDropOnFolder={(folderPath) => {
              const d = dragged.current;
              if (d && d.path !== folderPath && parentOf(d.path) !== folderPath) {
                onMove(d, folderPath);
              }
              dragged.current = null;
              setDropTarget(null);
            }}
            onSetDropTarget={setDropTarget}
          />
        ))}

        {visibleTree.length === 0 && (
          <div
            style={{
              fontSize: 11,
              color: C.textFaint,
              padding: "8px 8px",
              fontFamily: FONT.mono,
            }}
          >
            {tagFilteredNoteIds
              ? "keine notizen mit diesem tag"
              : "leerer vault — neue notiz anlegen?"}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Zeile (rekursiv) ---------------- */

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  editing: Editing;
  activeId: string | null;
  dropTarget: string | null;
  onToggle: (path: string) => void;
  onOpen: (id: string) => void;
  onStartEdit: (e: Editing) => void;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
  onDelete: (node: TreeNode) => void;
  onDragStart: (node: TreeNode) => void;
  onDropOnFolder: (folderPath: string) => void;
  onSetDropTarget: (path: string | null) => void;
}

function Row(props: RowProps) {
  const {
    node,
    depth,
    expanded,
    editing,
    activeId,
    dropTarget,
    onToggle,
    onOpen,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
    onDelete,
    onDragStart,
    onDropOnFolder,
    onSetDropTarget,
  } = props;

  const [hover, setHover] = useState(false);
  const isFolder = node.type === "folder";
  const isOpen = expanded.has(node.path);
  const isActive = node.type === "note" && node.path === activeId;
  const isRenaming = editing?.mode === "rename" && editing.path === node.path;
  const isDropHere = isFolder && dropTarget === node.path;

  if (isRenaming) {
    return (
      <InlineInput
        depth={depth}
        kind={node.type}
        initial={node.name}
        onCommit={onCommitEdit}
        onCancel={onCancelEdit}
      />
    );
  }

  return (
    <>
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          onDragStart(node);
        }}
        onDragOver={
          isFolder
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onSetDropTarget(node.path);
              }
            : undefined
        }
        onDragLeave={
          isFolder
            ? () => onSetDropTarget(null)
            : undefined
        }
        onDrop={
          isFolder
            ? (e) => {
                e.stopPropagation();
                onDropOnFolder(node.path);
              }
            : undefined
        }
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => (isFolder ? onToggle(node.path) : onOpen(node.path))}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "4px 6px",
          paddingLeft: 6 + depth * 12,
          marginBottom: 1,
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 13.5,
          background: isActive
            ? C.selection
            : isDropHere
              ? C.hover
              : hover
                ? C.elevated
                : "transparent",
          outline: isDropHere ? `1px dashed ${C.accent}` : "none",
          color: isActive ? C.text : C.textDim,
        }}
      >
        {isFolder ? (
          <ChevronRight
            size={16}
            style={{
              color: isActive || isOpen ? C.accent : C.textDim,
              flexShrink: 0,
              transform: isOpen ? "rotate(90deg)" : "none",
              transition: "transform 0.12s",
            }}
          />
        ) : (
          <span style={{ width: 16, flexShrink: 0 }} />
        )}
        {isFolder ? (
          <Folder size={18} style={{ color: C.gold, flexShrink: 0 }} />
        ) : (
          <File
            size={18}
            style={{ color: isActive ? C.accent : C.textDim, flexShrink: 0 }}
          />
        )}
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.name}
        </span>

        {/* Aktionen beim Hovern */}
        {hover && (
          <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            {isFolder && (
              <>
                <IconButton
                  title="Neue Notiz"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartEdit({ mode: "new-note", parentPath: node.path });
                  }}
                >
                  <FilePlus size={16} />
                </IconButton>
                <IconButton
                  title="Neuer Ordner"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartEdit({ mode: "new-folder", parentPath: node.path });
                  }}
                >
                  <FolderPlus size={16} />
                </IconButton>
              </>
            )}
            <IconButton
              title="Umbenennen"
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit({ mode: "rename", path: node.path });
              }}
            >
              <Pencil size={16} />
            </IconButton>
            <IconButton
              title="Löschen"
              onClick={(e) => {
                e.stopPropagation();
                if (
                  window.confirm(
                    `"${node.name}" wirklich löschen? Wird aus Forgejo entfernt.`,
                  )
                ) {
                  onDelete(node);
                }
              }}
            >
              <Trash2 size={16} />
            </IconButton>
          </span>
        )}
      </div>

      {/* Kinder + ggf. Inline-Eingabe für neue Einträge in diesem Ordner */}
      {isFolder && isOpen && (
        <>
          {editing &&
            "parentPath" in editing &&
            editing.parentPath === node.path && (
              <InlineInput
                depth={depth + 1}
                kind={editing.mode === "new-folder" ? "folder" : "note"}
                onCommit={onCommitEdit}
                onCancel={onCancelEdit}
              />
            )}
          {node.children.map((child) => (
            <Row key={child.path} {...props} node={child} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

/* ---------------- Inline-Eingabe ---------------- */

function InlineInput({
  depth,
  kind,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "note" | "folder";
  initial?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 6px",
        paddingLeft: 6 + depth * 12 + 17,
      }}
    >
      {kind === "folder" ? (
        <Folder size={13} style={{ color: C.gold, flexShrink: 0 }} />
      ) : (
        <File size={13} style={{ color: C.textFaint, flexShrink: 0 }} />
      )}
      <input
        autoFocus
        value={value}
        placeholder={kind === "folder" ? "Ordnername" : "Notizname"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCommit(value)}
        style={{
          flex: 1,
          background: C.bg,
          border: `1px solid ${C.accent}`,
          borderRadius: 4,
          color: C.text,
          fontSize: 12,
          fontFamily: FONT.ui,
          padding: "2px 6px",
          outline: "none",
        }}
      />
    </div>
  );
}

/* ---------------- kleiner Icon-Button ---------------- */

function IconButton({
  children,
  title,
  onClick,
}: {
  children: ReactNode;
  title: string;
  onClick: (e: MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        border: "none",
        borderRadius: 4,
        cursor: "pointer",
        background: hover ? C.hover : "transparent",
        color: hover ? C.accent : C.textDim,
      }}
    >
      {children}
    </button>
  );
}

/* ---------------- Helper ---------------- */

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children.length) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}
