import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { SetupGate } from "./SetupGate.js";
import { AuthGate } from "./AuthGate.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ShareTarget } from "./share/ShareTarget.js";

/*
 * Story 11.8 — Web-Share-Target-Route. Der Service Worker redirectet den
 * geteilten POST auf GET `/share`; hier zweigen wir VOR der App-Shell ab und
 * rendern den schlanken Quittungs-Screen (kein Setup/Auth-Gate nötig — der
 * Share landet ohnehin nur in der Inbox-Queue). Alle anderen Pfade laufen
 * unverändert durch SetupGate → AuthGate → App.
 */
const isShareRoute =
  typeof window !== "undefined" && window.location.pathname === "/share";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isShareRoute ? (
        <ShareTarget />
      ) : (
        <SetupGate>
          <AuthGate>
            <App />
          </AuthGate>
        </SetupGate>
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
