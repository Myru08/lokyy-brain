import { useEffect, useRef, useState } from "react";
import { C } from "./theme.js";

/**
 * Resizable-Handle — vertikale Trennlinie zwischen zwei Panels.
 * Drag verschiebt die linke Panel-Breite; Wert wird in localStorage gehalten.
 *
 *   <Resizable storageKey="filetree" min={160} max={500} default={248}>
 *     {(width) => <aside style={{width}}>…</aside>}
 *   </Resizable>
 *
 * Plus: Doppelklick auf den Handle resettet auf default.
 */
export function useResizableWidth(opts: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}): [number, (n: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(`lokyy:resize:${opts.storageKey}`);
      if (raw) {
        const n = Number(raw);
        if (!isNaN(n) && n >= opts.min && n <= opts.max) return n;
      }
    } catch {}
    return opts.defaultWidth;
  });

  useEffect(() => {
    try {
      localStorage.setItem(`lokyy:resize:${opts.storageKey}`, String(width));
    } catch {}
  }, [opts.storageKey, width]);

  function safeSet(n: number) {
    setWidth(Math.max(opts.min, Math.min(opts.max, n)));
  }

  return [width, safeSet];
}

/**
 * Drag-Handle zwischen zwei Panels. side="left" bedeutet: dragging nach
 * rechts vergrößert das links-stehende Panel. side="right" invers.
 */
export function DragHandle({
  side,
  getWidth,
  setWidth,
  onReset,
}: {
  side: "left" | "right";
  getWidth: () => number;
  setWidth: (n: number) => void;
  onReset?: () => void;
}) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const delta = side === "left" ? dx : -dx;
      setWidth(dragRef.current.startW + delta);
    }
    function onUp() {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [side, setWidth]);

  return (
    <div
      onMouseDown={(e) => {
        dragRef.current = { startX: e.clientX, startW: getWidth() };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onDoubleClick={onReset}
      title="Ziehen zum Ändern · Doppelklick reset"
      style={{
        width: 6,
        flexShrink: 0,
        cursor: "col-resize",
        background: "transparent",
        borderLeft: `1px solid ${C.borderSoft}`,
        transition: "background 120ms",
        zIndex: 5,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = C.accentDim;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    />
  );
}
