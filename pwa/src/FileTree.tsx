import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
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
  /**
   * Zuletzt geklickter Ordner — wird beim Erstellen einer neuen Notiz /
   * eines neuen Ordners aus der Kopfzeile als Parent verwendet. Ohne
   * Auswahl (oder wenn der Ordner ausgeblendet wird) fällt das Verhalten
   * auf den Vault-Root zurück.
   */
  const [activeFolder, setActiveFolder] = useState<string>("");
  // Ref auf die DOM-Zeile der aktiven Notiz, damit wir sie bei jedem
  // Wechsel sanft in den sichtbaren Bereich scrollen können.
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeId) return;
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // Wenn der gemerkte Ordner nach einem Rename / Delete / Tag-Filter aus
  // dem Baum verschwindet, fällt die Auswahl auf den Vault-Root zurück —
  // sonst zeigt die Kopfzeile dauerhaft einen Tooltip auf einen Pfad,
  // den es nicht mehr gibt.
  useEffect(() => {
    if (!activeFolder) return;
    if (!findNode(tree, activeFolder)) setActiveFolder("");
  }, [tree, activeFolder]);

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
          title={
            activeFolder
              ? `Neue Notiz in "${activeFolder}"`
              : "Neue Notiz im Vault-Root"
          }
          onClick={() => {
            // Sticky-Folder: neue Einträge landen im zuletzt gewählten
            // Ordner; ohne Auswahl im Vault-Root.
            if (activeFolder) {
              setExpanded((prev) => new Set(prev).add(activeFolder));
            }
            setEditing({ mode: "new-note", parentPath: activeFolder });
          }}
        >
          <FilePlus size={18} />
        </IconButton>
        <IconButton
          title={
            activeFolder
              ? `Neuer Ordner in "${activeFolder}"`
              : "Neuer Ordner im Vault-Root"
          }
          onClick={() => {
            if (activeFolder) {
              setExpanded((prev) => new Set(prev).add(activeFolder));
            }
            setEditing({ mode: "new-folder", parentPath: activeFolder });
          }}
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
            activeFolder={activeFolder}
            dropTarget={dropTarget}
            activeRowRef={activeRowRef}
            onToggle={toggle}
            onOpen={onOpen}
            onSelectFolder={setActiveFolder}
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
  activeFolder: string;
  dropTarget: string | null;
  activeRowRef: MutableRefObject<HTMLDivElement | null>;
  onToggle: (path: string) => void;
  onOpen: (id: string) => void;
  onSelectFolder: (path: string) => void;
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
    activeFolder,
    dropTarget,
    activeRowRef,
    onToggle,
    onOpen,
    onSelectFolder,
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
  const isFolderSelected = isFolder && node.path === activeFolder;
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
        ref={isActive ? activeRowRef : undefined}
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
        onClick={() => {
          if (isFolder) {
            // Sticky-Folder: jeder Folder-Click merkt sich den Pfad,
            // damit folgende „Neue Notiz / Neuer Ordner"-Aktionen aus
            // der Kopfzeile hier hineinarbeiten.
            onSelectFolder(node.path);
            onToggle(node.path);
          } else {
            onOpen(node.path);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "4px 6px",
          // Linker Akzent-Balken bei aktiver Notiz / gewähltem Ordner.
          // 3px Balken + 3px Innenabstand kompensieren das ursprüngliche
          // 6px-Padding, damit die Zeile nicht „springt".
          paddingLeft:
            (isActive || isFolderSelected ? 3 : 6) + depth * 12,
          borderLeft:
            isActive
              ? `3px solid ${C.accent}`
              : isFolderSelected
                ? `3px solid ${C.gold}`
                : "3px solid transparent",
          marginBottom: 1,
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 13.5,
          background: isActive
            ? C.selection
            : isFolderSelected
              ? C.accentSoft
              : isDropHere
                ? C.hover
                : hover
                  ? C.elevated
                  : "transparent",
          outline: isDropHere ? `1px dashed ${C.accent}` : "none",
          color: isActive ? C.text : C.textDim,
          fontWeight: isActive ? 600 : 400,
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
                // Bei nicht-leeren Ordnern eine zusätzliche, deutlichere
                // Warnung — Forgejo behält zwar die History, aber das
                // Working-Copy-Delete kann ganze Unterbäume mitziehen.
                const childCount = isFolder ? node.children.length : 0;
                const base = `"${node.name}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`;
                const message =
                  isFolder && childCount > 0
                    ? `WARNUNG: Der Ordner enthält ${childCount} Eintr${childCount === 1 ? "ag" : "äge"}, die ebenfalls gelöscht werden.\n\n${base}`
                    : base;
                if (window.confirm(message)) {
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
