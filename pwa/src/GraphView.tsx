import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Focus-on-Hover highlight set.
 *
 * `nodes`        — every node-id that should render at full opacity
 *                  (the hovered node plus all of its direct neighbors).
 * `links`        — every "src→tgt" key whose edge should be highlighted.
 * `hoveredId`    — the actually-hovered node, so we can paint it slightly
 *                  larger / brighter than its peers.
 */
interface Highlight {
  nodes: Set<string>;
  links: Set<string>;
  hoveredId: string;
}

/**
 * Stable key for a directed link. Source/target may arrive as either the
 * raw id string (before d3 resolves refs) or as a Node object (after).
 */
function linkKey(source: string, target: string): string {
  return `${source}→${target}`;
}

/**
 * Resolves the `source`/`target` field of a `react-force-graph-2d` link
 * back to its node id, regardless of whether d3 has already replaced the
 * id with the Node object.
 */
function endpointId(end: unknown): string {
  if (typeof end === "string") return end;
  if (end && typeof end === "object" && "id" in end) {
    return String((end as { id: unknown }).id);
  }
  return String(end);
}

// --- Brand palette (per spec) -------------------------------------------
// Dimmed values are tuned to read as "still there, but background". They
// must stay above the canvas background contrast threshold or the graph
// reads as broken.
const COLOR_NODE_NORMAL = C.accent;            // "#F97316"
const COLOR_NODE_HOVER = C.accentHi;           // "#FB923C"
const COLOR_NODE_NEIGHBOR = C.gold;            // "#FFA94D"
const COLOR_NODE_DIMMED = "rgba(249,115,22,0.15)";
const COLOR_EDGE_NORMAL = C.textFaint;         // "#5A6270"
const COLOR_EDGE_HIGHLIGHT = C.accent;         // "#F97316"
const COLOR_EDGE_DIMMED = "rgba(90,98,112,0.08)";

/**
 * Wissensgraph-Vollbild-Overlay.
 *
 * Holt /api/graph, rendert die Knoten als ForceGraph2D mit Klick →
 * öffnet die Note. Hover hebt die direkten Nachbarn vollständig hervor
 * und dimmt alles andere stark. Klick aufs X schließt das Overlay.
 * Esc schließt auch.
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
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  // Hover-debounce. `react-force-graph-2d` fires onNodeHover every frame
  // the cursor moves, including while the same node stays under the
  // mouse. Recomputing the highlight set + triggering a React re-render
  // on every frame is wasteful — we coalesce identical hovers and delay
  // state updates by ~50ms so quick mouse-sweeps over the graph don't
  // create a thrash of intermediate highlight sets.
  const hoverTimerRef = useRef<number | null>(null);
  const lastHoverIdRef = useRef<string | null>(null);

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

  // Adjacency map — `nodeId → Set(neighborIds)`. Built once per edge-set
  // change, reused by hover. O(|E|) build, O(deg(v)) hover lookup.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      const s = endpointId(e.source);
      const t = endpointId(e.target);
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  }, [edges]);

  // Cache: hovered-id → precomputed Highlight. Recomputing the link-set
  // for every render of a 1000+ node graph would block paint; we memoize
  // per (adjacency, edges) and lazily fill as the user hovers.
  const highlightCacheRef = useRef<Map<string, Highlight>>(new Map());
  useEffect(() => {
    // Adjacency or edges changed → cached link-sets are stale.
    highlightCacheRef.current = new Map();
  }, [adjacency, edges]);

  /**
   * Builds (or returns the cached) Highlight for a given node-id.
   * Encapsulates the link-key resolution so hover handling stays cheap.
   */
  const computeHighlight = useCallback(
    (id: string): Highlight => {
      const cached = highlightCacheRef.current.get(id);
      if (cached) return cached;

      const nbrs = adjacency.get(id) ?? new Set<string>();
      const nodeSet = new Set<string>([id]);
      for (const n of nbrs) nodeSet.add(n);

      const linkSet = new Set<string>();
      for (const e of edges) {
        const s = endpointId(e.source);
        const t = endpointId(e.target);
        if (s === id || t === id) linkSet.add(linkKey(s, t));
      }

      const built: Highlight = { nodes: nodeSet, links: linkSet, hoveredId: id };
      highlightCacheRef.current.set(id, built);
      return built;
    },
    [adjacency, edges]
  );

  /**
   * Debounced hover handler. We ignore identical hovers (`prev === next`)
   * and coalesce rapid changes into a single state update.
   */
  const handleNodeHover = useCallback(
    (n: object | null) => {
      const nextId = n ? (n as Node).id : null;
      if (nextId === lastHoverIdRef.current) return;
      lastHoverIdRef.current = nextId;

      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        setHighlight(nextId ? computeHighlight(nextId) : null);
      }, 50);
    },
    [computeHighlight]
  );

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const data = useMemo(() => ({ nodes, links: edges }), [nodes, edges]);

  // --- ForceGraph accessors. Defined as stable callbacks so the canvas
  //     doesn't re-allocate them every render (which would defeat the
  //     graph's internal memoisation of paint state). -------------------

  const linkColor = useCallback(
    (l: object): string => {
      const link = l as { source: unknown; target: unknown };
      if (!highlight) return COLOR_EDGE_NORMAL;
      const s = endpointId(link.source);
      const t = endpointId(link.target);
      return highlight.links.has(linkKey(s, t)) ? COLOR_EDGE_HIGHLIGHT : COLOR_EDGE_DIMMED;
    },
    [highlight]
  );

  const linkWidth = useCallback(
    (l: object): number => {
      const link = l as { source: unknown; target: unknown };
      if (!highlight) return 0.5;
      const s = endpointId(link.source);
      const t = endpointId(link.target);
      return highlight.links.has(linkKey(s, t)) ? 2 : 0.5;
    },
    [highlight]
  );

  const nodeColor = useCallback(
    (n: object): string => {
      const nn = n as Node;
      if (!highlight) return COLOR_NODE_NORMAL;
      if (highlight.hoveredId === nn.id) return COLOR_NODE_HOVER;
      if (highlight.nodes.has(nn.id)) return COLOR_NODE_NEIGHBOR;
      return COLOR_NODE_DIMMED;
    },
    [highlight]
  );

  // nodeVal feeds into the built-in radius formula:
  //   r = nodeRelSize * sqrt(nodeVal)
  // 1   → standard radius
  // 2.25 → 1.5x radius (hovered)
  // 0.7  → slightly smaller for dimmed (visually recedes)
  const nodeVal = useCallback(
    (n: object): number => {
      const nn = n as Node;
      if (!highlight) return 1;
      if (highlight.hoveredId === nn.id) return 2.25;
      if (highlight.nodes.has(nn.id)) return 1;
      return 0.7;
    },
    [highlight]
  );

  /**
   * Label painter. We always paint labels for the hovered node and its
   * direct neighbors at high contrast and a slightly larger font, even
   * at low zoom — that's the whole point of the focus-on-hover UX.
   * Non-highlighted labels only appear once the user zooms in.
   */
  const nodeCanvasObject = useCallback(
    (n: object, ctx: CanvasRenderingContext2D, scale: number) => {
      const nn = n as Node;
      const isHovered = highlight?.hoveredId === nn.id;
      const isNeighbor = highlight?.nodes.has(nn.id) ?? false;
      const isDimmed = highlight !== null && !isNeighbor;

      // Skip labels for dimmed nodes entirely — they should fade into
      // the background. Skip labels for normal nodes when we're zoomed
      // out to avoid label-spam.
      if (isDimmed) return;
      if (!highlight && scale < 1.5) return;

      // Highlighted labels (hovered or neighbor) get a larger font and
      // a subtle background plate so they stay readable on top of edges.
      const baseFont = isHovered ? 14 : isNeighbor ? 12 : 11;
      const fontSize = baseFont / scale;
      ctx.font = `${isHovered ? "600 " : ""}${fontSize}px Bricolage Grotesque, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const cx = nn.x ?? 0;
      const cy = (nn.y ?? 0) + (isHovered ? 16 : 12) / scale;

      if (isHovered || isNeighbor) {
        // Background plate for legibility.
        const metrics = ctx.measureText(nn.title);
        const padX = 4 / scale;
        const padY = 2 / scale;
        ctx.fillStyle = "rgba(19,23,29,0.85)"; // C.bg @ 85%
        ctx.fillRect(
          cx - metrics.width / 2 - padX,
          cy - fontSize / 2 - padY,
          metrics.width + padX * 2,
          fontSize + padY * 2
        );
      }

      ctx.fillStyle = isHovered ? C.text : isNeighbor ? C.text : C.textDim;
      ctx.fillText(nn.title, cx, cy);
    },
    [highlight]
  );

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
          Klick öffnet · Hover fokussiert · Esc schließt
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

      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          cursor: highlight ? "pointer" : "default",
        }}
      >
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
            nodeVal={nodeVal}
            linkColor={linkColor}
            linkWidth={linkWidth}
            nodeColor={nodeColor}
            nodeLabel={(n) => (n as Node).title}
            onNodeHover={handleNodeHover}
            onNodeClick={(n) => onOpenNote((n as Node).id)}
            cooldownTicks={120}
            d3VelocityDecay={0.3}
            nodeCanvasObjectMode={() => "after"}
            nodeCanvasObject={nodeCanvasObject}
          />
        )}
      </div>
    </div>
  );
}
