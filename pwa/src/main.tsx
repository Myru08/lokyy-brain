import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { SetupGate } from "./SetupGate.js";
import { AuthGate } from "./AuthGate.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SetupGate>
      <AuthGate>
        <App />
      </AuthGate>
    </SetupGate>
  </React.StrictMode>,
);
