import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { SetupGate } from "./SetupGate.js";
import { AuthGate } from "./AuthGate.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SetupGate>
        <AuthGate>
          <App />
        </AuthGate>
      </SetupGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
