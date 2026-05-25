# Story 1.11: Setup Wizard Frontend

Status: done

## Done
- `pwa/src/SetupGate.tsx` — polls /api/setup/status; renders SetupWizard if false, children if true.
- `pwa/src/SetupWizard.tsx` — 6-step wizard (Forgejo, Postgres, Ollama, Admin, Vault, Done) with per-step Test button + Weiter gate.
- `pwa/src/main.tsx` — wraps `<App />` in `<SetupGate>`.
- Playwright verified both modes:
  - With setup_complete=false: wizard renders (screenshot lokyy-story-1-11-wizard.png — header "lokyy-brain Setup", stepper, Forgejo step with fields).
  - After API-completed setup + reload: normal App shell returns (screenshot lokyy-story-1-11-after.png).
- Build green; no new console errors.
