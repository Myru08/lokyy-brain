import React, { useState, useEffect, useRef } from "react";
import * as d3 from "d3";
import {
  Network,
  FileText,
  Youtube,
  Mic,
  GitBranch,
  Plus,
  Search,
  Hash,
  CircleDot,
  Inbox,
  Check,
  Loader2,
} from "lucide-react";

/**
 * lokyy-brain — visueller Mockup (Design-Referenz für Epic 2)
 * Eigenständiges, Obsidian-nahes Knowledge-Tool.
 * Forgejo = Wahrheit · CM6-Live-Preview · Wissensgraph · Pipes-Inbox
 *
 * Das ist eine Design-Visualisierung, kein Produktivcode — der echte
 * Editor läuft auf CodeMirror 6, hier ist die Live-Preview nachgebaut,
 * damit Look & Interaktion fühlbar werden.
 */

const C = {
  bg: "#14110f",
  panel: "#1b1714",
  elevated: "#231e1a",
  hover: "#2b2520",
  border: "#322b25",
  borderSoft: "#272019",
  text: "#ece6df",
  textDim: "#9a8f84",
  textFaint: "#5f574e",
  accent: "#d2693f",
  accentHi: "#e8814f",
  accentDim: "#3a261c",
  gold: "#c9a25e",
  ok: "#7fa37a",
};

const FONTS = {
  ui: "'Bricolage Grotesque', sans-serif",
  serif: "'Fraunces', Georgia, serif",
  mono: "'JetBrains Mono', monospace",
};

/* ---------- seed data ---------- */
const SEED = {
  "pai-arch": {
    id: "pai-arch",
    title: "PAI Architektur",
    tags: ["pai", "infra"],
    body: `# PAI Architektur

Der persönliche AI-Assistent läuft self-hosted auf **Hetzner**. Drei Schichten greifen ineinander.

## Schichten
- [[Hermes]] als Agent-Layer — kein OpenClaw
- [[Paperclip]] für die Team-Orchestrierung
- [[Cognee]] als zweites Gehirn und Knowledge-Graph

Der Ingest folgt dem Karpathy-Pattern und läuft über [[Claude Code Ingest]].

#pai #infra`,
  },
  hermes: {
    id: "hermes",
    title: "Hermes",
    tags: ["pai"],
    body: `# Hermes

Agent-Layer der [[PAI Architektur]]. Steht auf *100%* — bewusst **ohne** OpenClaw, um die Kette schlank zu halten.

#pai`,
  },
  cognee: {
    id: "cognee",
    title: "Cognee",
    tags: ["pai", "memory"],
    body: `# Cognee

Self-hosted auf Hetzner, ersetzt Graphiti. Memory- und Knowledge-Graph-Layer der [[PAI Architektur]].

Speist sich aus der [[ECL Pipeline]] und liefert Vector-RAG.

#memory`,
  },
  paperclip: {
    id: "paperclip",
    title: "Paperclip",
    tags: ["pai"],
    body: `# Paperclip

Orchestriert die Agent-Teams in der [[PAI Architektur]]. Hält die Übergaben zwischen den \`workern\` sauber.

#pai`,
  },
  ecl: {
    id: "ecl",
    title: "ECL Pipeline",
    tags: ["memory"],
    body: `# ECL Pipeline

Extract · Cognify · Load. Befüllt [[Cognee]] und wird von [[Claude Code Ingest]] angestoßen.

#memory`,
  },
  cc: {
    id: "cc",
    title: "Claude Code Ingest",
    tags: ["pai", "infra"],
    body: `# Claude Code Ingest

Übernimmt den Ingest nach dem Karpathy-Pattern und triggert die [[ECL Pipeline]].

#infra`,
  },
  synkea: {
    id: "synkea",
    title: "SYNKEA",
    tags: ["business"],
    body: `# SYNKEA

Modulare Multi-Tenant KI-Ops-Plattform für §203-Berufe. *Connect to everything.*

Markenseitig flankiert von [[Aiianer]].

#business`,
  },
  aiianer: {
    id: "aiianer",
    title: "Aiianer",
    tags: ["business", "content"],
    body: `# Aiianer

KI-Advisor-Marke — wie ein Marsianer auf dem Mars, nur eben auf dem KI-Planeten.

Strategisch gekoppelt an [[SYNKEA]], getragen von der [[Produkt-Ladder]].

#content`,
  },
  ladder: {
    id: "ladder",
    title: "Produkt-Ladder",
    tags: ["business"],
    body: `# Produkt-Ladder

49 € → 299 € → 99 €/Mo → Bootcamps. Das Rückgrat der [[Aiianer]]-Monetarisierung.

#business`,
  },
  konzept: {
    id: "konzept",
    title: "lokyy-brain Konzept",
    tags: ["infra", "meta"],
    body: `# lokyy-brain Konzept

Eigenständiges Tool, so nah wie möglich an Obsidian. Forgejo ist die Wahrheit: vor dem Editieren wird gepullt, beim Speichern committet & gepusht.

Dokumentiert die [[PAI Architektur]] und alles drumherum.

#meta`,
  },
};

/* ---------- helpers ---------- */
function parseLinks(body) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1].trim());
  return out;
}

function useFonts() {
  useEffect(() => {
    const id = "sw-fonts";
    if (document.getElementById(id)) return;
    const l = document.createElement("link");
    l.id = id;
    l.rel = "stylesheet";
    l.href =
      "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(l);
  }, []);
}

/* ---------- inline markdown renderer (live-preview style) ---------- */
function InlineMD({ text, raw, onOpenLink }) {
  if (raw) {
    return <span style={{ color: C.textDim, fontFamily: FONTS.mono }}>{text}</span>;
  }
  const nodes = [];
  let rest = text;
  let key = 0;
  const re =
    /(\[\[[^\]]+\]\])|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(#[\wÄÖÜäöüß-]+)/;
  while (rest.length) {
    const m = rest.match(re);
    if (!m) {
      nodes.push(<span key={key++}>{rest}</span>);
      break;
    }
    if (m.index > 0) nodes.push(<span key={key++}>{rest.slice(0, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("[[")) {
      const name = tok.slice(2, -2);
      nodes.push(
        <span
          key={key++}
          onClick={() => onOpenLink && onOpenLink(name)}
          style={{
            color: C.accent,
            cursor: "pointer",
            borderBottom: `1px solid ${C.accentDim}`,
          }}
        >
          {name}
        </span>
      );
    } else if (tok.startsWith("**")) {
      nodes.push(
        <strong key={key++} style={{ color: C.text, fontWeight: 600 }}>
          {tok.slice(2, -2)}
        </strong>
      );
    } else if (tok.startsWith("*")) {
      nodes.push(
        <em key={key++} style={{ color: C.text }}>
          {tok.slice(1, -1)}
        </em>
      );
    } else if (tok.startsWith("`")) {
      nodes.push(
        <code
          key={key++}
          style={{
            fontFamily: FONTS.mono,
            fontSize: "0.85em",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            padding: "1px 5px",
            color: C.gold,
          }}
        >
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("#")) {
      nodes.push(
        <span
          key={key++}
          style={{
            color: C.gold,
            background: "rgba(201,162,94,0.09)",
            border: "1px solid rgba(201,162,94,0.2)",
            borderRadius: 5,
            padding: "0 6px",
            fontSize: "0.82em",
          }}
        >
          {tok}
        </span>
      );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return <>{nodes}</>;
}

/* ---------- editor pane ---------- */
function EditorPane({ note, onOpenLink }) {
  const [activeLine, setActiveLine] = useState(-1);
  useEffect(() => setActiveLine(-1), [note.id]);
  const lines = note.body.split("\n");

  return (
    <div className="flex flex-col h-full" style={{ background: C.bg }}>
      <div
        className="flex items-center gap-2 px-4"
        style={{
          height: 38,
          borderBottom: `1px solid ${C.borderSoft}`,
          background: C.panel,
        }}
      >
        <FileText size={13} style={{ color: C.accent }} />
        <span style={{ fontSize: 12.5, color: C.text, fontFamily: FONTS.ui }}>
          {note.title}.md
        </span>
        <span style={{ fontSize: 11, color: C.textFaint }}>— bearbeitet</span>
        <div className="flex-1" />
        <CircleDot size={9} style={{ color: C.accent }} />
        <span style={{ fontSize: 10.5, color: C.textFaint, fontFamily: FONTS.mono }}>
          ungespeichert
        </span>
      </div>

      <div
        className="flex-1 overflow-auto px-10 py-8"
        style={{ fontFamily: FONTS.serif }}
      >
        <div style={{ maxWidth: 620, margin: "0 auto" }}>
          {lines.map((line, i) => {
            const active = i === activeLine;
            const h1 = line.startsWith("# ");
            const h2 = line.startsWith("## ");
            const li = line.startsWith("- ");
            let content = line;
            let style = {
              fontSize: 15.5,
              lineHeight: "1.85",
              color: C.text,
              minHeight: "1.85em",
            };
            if (h1) {
              content = active ? line : line.slice(2);
              style = { ...style, fontSize: 27, fontWeight: 600, lineHeight: "1.5", marginBottom: 4 };
            } else if (h2) {
              content = active ? line : line.slice(3);
              style = { ...style, fontSize: 19, fontWeight: 600, lineHeight: "1.6", marginTop: 14, color: C.text };
            } else if (li && !active) {
              content = line.slice(2);
            }
            return (
              <div
                key={i}
                onClick={() => setActiveLine(i)}
                style={{
                  ...style,
                  cursor: "text",
                  paddingLeft: li && !active ? 18 : 0,
                  position: "relative",
                  background: active ? "rgba(210,105,63,0.05)" : "transparent",
                  borderRadius: 3,
                }}
              >
                {li && !active && (
                  <span
                    style={{
                      position: "absolute",
                      left: 2,
                      color: C.accent,
                      fontSize: 13,
                    }}
                  >
                    •
                  </span>
                )}
                {(h1 || h2) && active && null}
                {content === "" ? (
                  <span>&nbsp;</span>
                ) : (
                  <InlineMD text={content} raw={active} onOpenLink={onOpenLink} />
                )}
              </div>
            );
          })}
          <div style={{ height: 30 }} />
          <div
            style={{
              fontFamily: FONTS.mono,
              fontSize: 10.5,
              color: C.textFaint,
              borderTop: `1px dashed ${C.border}`,
              paddingTop: 10,
            }}
          >
            klick in eine zeile → roher markdown (cursor) · klick raus → live-preview
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- graph view ---------- */
function GraphView({ notes, activeId, onSelect }) {
  const [, tick] = useState(0);
  const dataRef = useRef({ nodes: [], links: [] });
  const simRef = useRef(null);
  const [hover, setHover] = useState(null);
  const noteIds = Object.keys(notes).join(",");

  useEffect(() => {
    const titleToId = {};
    Object.values(notes).forEach((n) => (titleToId[n.title] = n.id));
    const prev = {};
    dataRef.current.nodes.forEach((n) => (prev[n.id] = n));
    const nodes = Object.values(notes).map((n) => {
      const p = prev[n.id];
      return p
        ? Object.assign(p, { title: n.title })
        : { id: n.id, title: n.title, x: (Math.random() - 0.5) * 80, y: (Math.random() - 0.5) * 80 };
    });
    const links = [];
    Object.values(notes).forEach((n) => {
      parseLinks(n.body).forEach((t) => {
        const tid = titleToId[t];
        if (tid && tid !== n.id) links.push({ source: n.id, target: tid });
      });
    });
    dataRef.current = { nodes, links };
    simRef.current && simRef.current.stop();
    const sim = d3
      .forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance(58).strength(0.45))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(0, 0))
      .force("collide", d3.forceCollide(24))
      .alpha(0.9)
      .on("tick", () => tick((t) => t + 1));
    simRef.current = sim;
    return () => sim.stop();
  }, [noteIds]);

  const { nodes, links } = dataRef.current;
  const focus = hover || activeId;
  const neighbors = new Set([focus]);
  links.forEach((l) => {
    const s = l.source.id || l.source;
    const t = l.target.id || l.target;
    if (s === focus) neighbors.add(t);
    if (t === focus) neighbors.add(s);
  });

  return (
    <div className="flex flex-col h-full" style={{ background: C.panel }}>
      <div
        className="flex items-center gap-2 px-3"
        style={{ height: 38, borderBottom: `1px solid ${C.borderSoft}` }}
      >
        <Network size={13} style={{ color: C.accent }} />
        <span style={{ fontSize: 11.5, color: C.textDim, fontFamily: FONTS.ui, fontWeight: 600 }}>
          WISSENSGRAPH
        </span>
        <div className="flex-1" />
        <span style={{ fontSize: 10, color: C.textFaint, fontFamily: FONTS.mono }}>
          {nodes.length} notizen · {links.length} kanten
        </span>
      </div>
      <div className="flex-1" style={{ overflow: "hidden" }}>
        <svg width="100%" height="100%" viewBox="-165 -150 330 300">
          {links.map((l, i) => {
            const s = typeof l.source === "object" ? l.source : nodes.find((n) => n.id === l.source);
            const t = typeof l.target === "object" ? l.target : nodes.find((n) => n.id === l.target);
            if (!s || !t) return null;
            const lit = neighbors.has(s.id) && neighbors.has(t.id);
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={lit ? C.accent : C.border}
                strokeWidth={lit ? 1.1 : 0.7}
                strokeOpacity={lit ? 0.65 : 0.5}
              />
            );
          })}
          {nodes.map((n) => {
            const isActive = n.id === activeId;
            const lit = neighbors.has(n.id);
            const r = isActive ? 7 : lit ? 5 : 4;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: "pointer" }}
                onClick={() => onSelect(n.id)}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
              >
                <circle
                  r={r}
                  fill={isActive ? C.accentHi : lit ? C.accent : C.elevated}
                  stroke={isActive ? C.accentHi : lit ? C.accent : C.textFaint}
                  strokeWidth={1}
                  fillOpacity={lit ? 1 : 0.85}
                />
                <text
                  y={r + 8}
                  textAnchor="middle"
                  style={{
                    fontFamily: FONTS.ui,
                    fontSize: 6.5,
                    fill: isActive ? C.text : lit ? C.textDim : C.textFaint,
                    fontWeight: isActive ? 700 : 400,
                    pointerEvents: "none",
                  }}
                >
                  {n.title}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/* ---------- sidebar ---------- */
function PipeItem({ icon: Icon, title, sub, color, status, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 w-full text-left"
      style={{
        padding: "7px 8px",
        borderRadius: 7,
        background: C.elevated,
        border: `1px solid ${C.border}`,
        marginBottom: 6,
        cursor: status === "ready" ? "pointer" : "default",
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: C.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon size={13} style={{ color }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 11.5,
            color: C.text,
            fontFamily: FONTS.ui,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 9.5, color: C.textFaint, fontFamily: FONTS.mono }}>
          {sub}
        </div>
      </div>
      {status === "processing" && (
        <Loader2 size={12} className="animate-spin" style={{ color: C.gold }} />
      )}
      {status === "ready" && (
        <span
          style={{
            fontSize: 8.5,
            color: C.accent,
            fontFamily: FONTS.mono,
            border: `1px solid ${C.accentDim}`,
            borderRadius: 4,
            padding: "1px 4px",
          }}
        >
          PIPE →
        </span>
      )}
    </button>
  );
}

function Sidebar({ notes, activeId, onSelect, onRunPipe, pipeState }) {
  const tags = {};
  Object.values(notes).forEach((n) =>
    n.tags.forEach((t) => (tags[t] = (tags[t] || 0) + 1))
  );
  return (
    <div
      className="flex flex-col h-full"
      style={{ background: C.panel, borderRight: `1px solid ${C.border}` }}
    >
      {/* search */}
      <div className="px-3" style={{ paddingTop: 10, paddingBottom: 8 }}>
        <div
          className="flex items-center gap-2"
          style={{
            background: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            padding: "5px 8px",
          }}
        >
          <Search size={12} style={{ color: C.textFaint }} />
          <span style={{ fontSize: 11, color: C.textFaint, fontFamily: FONTS.ui }}>
            Notizen durchsuchen…
          </span>
        </div>
      </div>

      {/* notes */}
      <div className="px-3 flex-1 overflow-auto">
        <div
          className="flex items-center gap-1"
          style={{ marginBottom: 4, marginTop: 4 }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: C.textDim,
              fontFamily: FONTS.ui,
              letterSpacing: 0.5,
            }}
          >
            NOTIZEN
          </span>
          <div className="flex-1" />
          <Plus size={13} style={{ color: C.textFaint }} />
        </div>
        {Object.values(notes).map((n) => {
          const act = n.id === activeId;
          return (
            <button
              key={n.id}
              onClick={() => onSelect(n.id)}
              className="flex items-center gap-2 w-full text-left"
              style={{
                padding: "5px 7px",
                borderRadius: 6,
                background: act ? C.accentDim : "transparent",
                marginBottom: 1,
              }}
            >
              <FileText
                size={12}
                style={{ color: act ? C.accent : C.textFaint, flexShrink: 0 }}
              />
              <span
                style={{
                  fontSize: 12,
                  color: act ? C.text : C.textDim,
                  fontFamily: FONTS.ui,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {n.title}
              </span>
            </button>
          );
        })}

        {/* tags */}
        <div style={{ marginTop: 14, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: C.textDim,
              fontFamily: FONTS.ui,
              letterSpacing: 0.5,
            }}
          >
            TAGS
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(tags).map(([t, c]) => (
            <span
              key={t}
              className="flex items-center gap-1"
              style={{
                fontSize: 10,
                color: C.gold,
                fontFamily: FONTS.mono,
                background: "rgba(201,162,94,0.08)",
                border: "1px solid rgba(201,162,94,0.18)",
                borderRadius: 5,
                padding: "1px 6px",
              }}
            >
              <Hash size={9} />
              {t} {c}
            </span>
          ))}
        </div>
      </div>

      {/* pipes inbox */}
      <div
        className="px-3"
        style={{ borderTop: `1px solid ${C.border}`, paddingTop: 9, paddingBottom: 10 }}
      >
        <div className="flex items-center gap-1" style={{ marginBottom: 7 }}>
          <Inbox size={12} style={{ color: C.accent }} />
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: C.textDim,
              fontFamily: FONTS.ui,
              letterSpacing: 0.5,
            }}
          >
            PIPES — INBOX
          </span>
        </div>
        <PipeItem
          icon={Youtube}
          title="Karpathy: LLM OS"
          sub={pipeState.yt === "done" ? "→ notiz erstellt" : "youtube · 1:04:22"}
          color="#d2493f"
          status={pipeState.yt === "done" ? "" : pipeState.yt}
          onClick={() => pipeState.yt === "ready" && onRunPipe("yt")}
        />
        <PipeItem
          icon={Mic}
          title="Sprachnotiz 14:32"
          sub={pipeState.voice === "done" ? "→ notiz erstellt" : "transkribiert gerade…"}
          color={C.gold}
          status={pipeState.voice === "done" ? "" : pipeState.voice}
          onClick={() => pipeState.voice === "ready" && onRunPipe("voice")}
        />
      </div>
    </div>
  );
}

/* ---------- top bar ---------- */
function TopBar({ note }) {
  const steps = ["synchron", "pull…", "commit…", "push…"];
  const [si, setSi] = useState(0);
  const run = () => {
    let i = 1;
    const iv = setInterval(() => {
      setSi(i);
      i++;
      if (i > 3) {
        clearInterval(iv);
        setTimeout(() => setSi(0), 700);
      }
    }, 620);
  };
  return (
    <div
      className="flex items-center gap-3 px-4"
      style={{
        height: 44,
        background: C.panel,
        borderBottom: `1px solid ${C.border}`,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: `radial-gradient(circle at 32% 30%, ${C.accentHi}, ${C.accent} 55%, #8a3f22)`,
          boxShadow: `0 0 12px rgba(210,105,63,0.35)`,
          flexShrink: 0,
        }}
      />
      <div>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 700,
            color: C.text,
            fontFamily: FONTS.ui,
            letterSpacing: -0.2,
            lineHeight: 1,
          }}
        >
          lokyy-brain
        </div>
        <div style={{ fontSize: 9, color: C.textFaint, fontFamily: FONTS.mono }}>
          knowledge-tool
        </div>
      </div>

      <div
        style={{
          width: 1,
          height: 20,
          background: C.border,
          margin: "0 4px",
        }}
      />
      <span style={{ fontSize: 12, color: C.textDim, fontFamily: FONTS.ui }}>
        Vault
      </span>
      <span style={{ fontSize: 12, color: C.textFaint }}>/</span>
      <span style={{ fontSize: 12, color: C.text, fontFamily: FONTS.ui }}>
        {note.title}
      </span>

      <div className="flex-1" />

      <button
        onClick={run}
        className="flex items-center gap-2"
        style={{
          background: si === 0 ? C.elevated : C.accentDim,
          border: `1px solid ${si === 0 ? C.border : C.accent}`,
          borderRadius: 7,
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        <GitBranch size={12} style={{ color: si === 0 ? C.ok : C.accentHi }} />
        <span
          style={{
            fontSize: 11,
            color: si === 0 ? C.textDim : C.accentHi,
            fontFamily: FONTS.mono,
          }}
        >
          forgejo · {steps[si]}
        </span>
        {si === 0 && <Check size={11} style={{ color: C.ok }} />}
      </button>
    </div>
  );
}

/* ---------- app ---------- */
export default function App() {
  useFonts();
  const [notes, setNotes] = useState(SEED);
  const [activeId, setActiveId] = useState("pai-arch");
  const [pipeState, setPipeState] = useState({ yt: "ready", voice: "processing" });
  const [toast, setToast] = useState(null);

  // voice note finishes "transcribing" on its own after mount
  useEffect(() => {
    const t = setTimeout(
      () => setPipeState((s) => ({ ...s, voice: "ready" })),
      2600
    );
    return () => clearTimeout(t);
  }, []);

  const openByTitle = (title) => {
    const hit = Object.values(notes).find((n) => n.title === title);
    if (hit) setActiveId(hit.id);
  };

  const runPipe = (which) => {
    setPipeState((s) => ({ ...s, [which]: "processing" }));
    const def =
      which === "yt"
        ? {
            id: "yt-karpathy",
            title: "Karpathy: LLM OS",
            tags: ["pai", "inbox"],
            body: `# Karpathy: LLM OS

> Automatisch erzeugt aus einer YouTube-Pipe — Transkript via Supadata.

Das LLM als neues Betriebssystem: der Kontext ist das RAM, Tools sind die Peripherie. Andockpunkt für die [[PAI Architektur]] und den [[Claude Code Ingest]].

#inbox #pai`,
          }
        : {
            id: "voice-1432",
            title: "Sprachnotiz 14:32",
            tags: ["inbox"],
            body: `# Sprachnotiz 14:32

> Automatisch erzeugt aus einer Sprachnachricht — Transkript via Whisper (self-hosted).

Idee: die [[Produkt-Ladder]] um ein kostenloses Intro-Modul ergänzen, das direkt in [[Aiianer]] reinzieht.

#inbox`,
          };
    setTimeout(() => {
      setNotes((n) => ({ ...n, [def.id]: def }));
      setPipeState((s) => ({ ...s, [which]: "done" }));
      setActiveId(def.id);
      setToast(`Neue Notiz aus Pipe: ${def.title}`);
      setTimeout(() => setToast(null), 3200);
    }, 1500);
  };

  const note = notes[activeId];

  return (
    <div
      className="flex flex-col"
      style={{
        height: "100vh",
        width: "100%",
        background: C.bg,
        color: C.text,
        fontFamily: FONTS.ui,
        overflow: "hidden",
      }}
    >
      <TopBar note={note} />
      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ width: 230, flexShrink: 0 }}>
          <Sidebar
            notes={notes}
            activeId={activeId}
            onSelect={setActiveId}
            onRunPipe={runPipe}
            pipeState={pipeState}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <EditorPane note={note} onOpenLink={openByTitle} />
        </div>
        <div
          style={{
            width: 310,
            flexShrink: 0,
            borderLeft: `1px solid ${C.border}`,
          }}
        >
          <GraphView notes={notes} activeId={activeId} onSelect={setActiveId} />
        </div>
      </div>

      {/* status bar */}
      <div
        className="flex items-center gap-3 px-4"
        style={{
          height: 24,
          background: C.panel,
          borderTop: `1px solid ${C.border}`,
          fontSize: 10,
          color: C.textFaint,
          fontFamily: FONTS.mono,
          flexShrink: 0,
        }}
      >
        <span>{note.body.split(/\s+/).length} wörter</span>
        <span>·</span>
        <span>zuletzt gepullt vor 2 min</span>
        <div className="flex-1" />
        <span>{Object.keys(notes).length} notizen im vault</span>
        <span>·</span>
        <span style={{ color: C.ok }}>● forgejo verbunden</span>
      </div>

      {/* toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 38,
            left: "50%",
            transform: "translateX(-50%)",
            background: C.elevated,
            border: `1px solid ${C.accent}`,
            borderRadius: 9,
            padding: "9px 16px",
            fontSize: 12,
            color: C.text,
            fontFamily: FONTS.ui,
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <CircleDot size={12} style={{ color: C.accent }} />
          {toast}
        </div>
      )}
    </div>
  );
}
