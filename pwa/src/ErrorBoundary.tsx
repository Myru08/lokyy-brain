import { Component, type ErrorInfo, type ReactNode } from "react";
import { C, FONT } from "./theme.js";

/**
 * Top-level React error boundary.
 *
 * Any render-time throw anywhere in the tree below this boundary is caught
 * here and replaced with a recoverable, themed fallback — instead of the
 * blank black screen React produces when an uncaught error unmounts the
 * whole tree. The fallback shows a short message, the (collapsible) error
 * text, and a "Neu laden" button that does a hard reload.
 *
 * This is the single safety net for the entire app: it is mounted once at
 * the root in `main.tsx`. Components may still surface their own inline
 * errors (e.g. AiProviderSettings save failures) — this boundary only
 * exists for the catastrophic case where a render actually throws.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console is enough for now — the server log buffer only picks this up
    // if forwarded, but at minimum it survives in the browser console.
    console.error("[ErrorBoundary] uncaught render error:", error, info.componentStack);
  }

  private handleReload = (): void => {
    location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message ?? "Unbekannter Fehler";
    const stack = this.state.error?.stack;

    return (
      <div
        style={{
          minHeight: "100vh",
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          boxSizing: "border-box",
          background: C.bg,
          color: C.text,
          fontFamily: FONT.ui,
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: "100%",
            padding: 24,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            textAlign: "center",
          }}
        >
          <h1
            style={{
              fontFamily: FONT.serif,
              fontSize: 22,
              margin: "0 0 8px 0",
              color: C.text,
            }}
          >
            Etwas ist abgestürzt
          </h1>
          <p style={{ color: C.textDim, fontSize: 13, margin: "0 0 18px 0" }}>
            Die Ansicht konnte nicht gerendert werden. Deine Daten sind nicht
            betroffen — lade die App neu.
          </p>

          <details
            style={{
              textAlign: "left",
              marginBottom: 18,
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "8px 10px",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                color: C.textDim,
                fontSize: 12,
                userSelect: "none",
              }}
            >
              Fehlerdetails
            </summary>
            <pre
              style={{
                margin: "8px 0 0 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: FONT.mono,
                fontSize: 11,
                color: C.err,
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {message}
              {stack ? `\n\n${stack}` : ""}
            </pre>
          </details>

          <button
            type="button"
            onClick={this.handleReload}
            style={{
              appearance: "none",
              border: "none",
              cursor: "pointer",
              padding: "10px 20px",
              borderRadius: 6,
              background: C.accent,
              color: C.bg,
              fontFamily: FONT.ui,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Neu laden
          </button>
        </div>
      </div>
    );
  }
}
