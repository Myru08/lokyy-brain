import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { X } from "lucide-react";
import { api } from "./api.js";
import { C, FONT } from "./theme.js";

interface Node {
  id: string;
  title: string;
  tags?: string[];
  // d3 internals injected at runtime; left optional for TS
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface Edge {
  source: string;
  target: string;
}

/**
 * Wissensgraph-Vollbild-Overlay.
 *
 * Holt /api/graph, rendert die Knoten als ForceGraph2D mit Klick →
 * öffnet die Note. Hover hebt direkte Nachbarn hervor. Klick aufs X
 * schließt das Overlay. Esc schließt auch.
 *
 * Style: warmes dunkles Theme passend zu lokyy-brain.
 */
export function GraphView({
  onClose,
  onOpenNote,
}: {
  onClose: () => void;
  onOpenNote: (id: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  // Load graph data
  useEffect(() => {
    let cancelled = false;
    void api.graph().then((g) => {
      if (cancelled) return;
      setNodes(g.nodes.map((n) => ({ id: n.id, title: n.title, tags: n.tags })));
      setEdges(g.edges.map((e) => ({ source: e.source, target: e.target })));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Track container size for the canvas
  useEffect(() => {
    function resize() {
      const el = containerRef.current;
      if (!el) return;
      setDims({ w: el.clientWidth, h: el.clientHeight });
    }
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pre-compute neighbor sets for highlighting
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      const s = String((e.source as unknown as Node).id ?? e.source);
      const t = String((e.target as unknown as Node).id ?? e.target);
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  }, [edges]);

  const data = useMemo(() => ({ nodes, links: edges }), [nodes, edges]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: C.bg,
        zIndex: 900,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "12px 18px",
          background: C.panel,
          borderBottom: `1px solid ${C.border}`,
          color: C.text,
          fontFamily: FONT.ui,
        }}
      >
        <strong style={{ fontFamily: FONT.serif, fontSize: 17, color: C.accent }}>
          Wissensgraph
        </strong>
        <span style={{ color: C.textDim, fontSize: 12, fontFamily: FONT.mono }}>
          {nodes.length} notes · {edges.length} links
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: C.textFaint, fontSize: 11, fontFamily: FONT.mono }}>
          Klick öffnet · Hover hebt Nachbarn hervor · Esc schließt
        </span>
        <button
          onClick={onClose}
          title="Schließen (Esc)"
          style={{
            display: "flex",
            alignItems: "center",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "5px 10px",
            cursor: "pointer",
            color: C.textDim,
            gap: 4,
            fontSize: 12,
            fontFamily: FONT.ui,
          }}
        >
          <X size={13} /> Schließen
        </button>
      </div>

      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {nodes.length === 0 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: C.textFaint,
              fontFamily: FONT.mono,
              fontSize: 13,
            }}
          >
            Graph wird geladen — oder Vault ist leer.
          </div>
        ) : (
          <ForceGraph2D
            graphData={data}
            width={dims.w}
            height={dims.h}
            backgroundColor={C.bg}
            nodeRelSize={5}
            linkColor={(l) => {
              const sid = String(((l.source as unknown) as Node).id ?? (l.source as unknown as string));
              const tid = String(((l.target as unknown) as Node).id ?? (l.target as unknown as string));
              if (hover && (hover === sid || hover === tid)) return C.accent;
              return C.borderSoft;
            }}
            linkWidth={(l) => {
              const sid = String(((l.source as unknown) as Node).id ?? (l.source as unknown as string));
              const tid = String(((l.target as unknown) as Node).id ?? (l.target as unknown as string));
              return hover && (hover === sid || hover === tid) ? 1.6 : 0.5;
            }}
            nodeColor={(n) => {
              const nn = n as Node;
              if (!hover) return C.accent;
              if (hover === nn.id) return C.accentHi;
              if (neighbors.get(hover)?.has(nn.id)) return C.gold;
              return C.borderSoft;
            }}
            nodeLabel={(n) => (n as Node).title}
            onNodeHover={(n) => setHover(n ? (n as Node).id : null)}
            onNodeClick={(n) => onOpenNote((n as Node).id)}
            cooldownTicks={120}
            d3VelocityDecay={0.3}
            nodeCanvasObjectMode={() => "after"}
            nodeCanvasObject={(node, ctx, scale) => {
              const nn = node as Node;
              if (scale < 1.5) return;
              const label = nn.title;
              const fontSize = 11 / scale;
              ctx.font = `${fontSize}px Bricolage Grotesque, system-ui, sans-serif`;
              ctx.fillStyle =
                !hover || hover === nn.id || neighbors.get(hover)?.has(nn.id)
                  ? C.text
                  : C.textFaint;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(label, nn.x ?? 0, (nn.y ?? 0) + 12 / scale);
            }}
          />
        )}
      </div>
    </div>
  );
}
