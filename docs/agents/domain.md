# Domain Docs

Wie Engineering-Skills die Domain-Dokumentation für lokyy-brain lesen sollen.

## Vor der Exploration lesen

- `CLAUDE.md` am Repo-Root — die primäre technische Dokumentation (Architektur, Data Flow, Services, Vault Contract).
- `CONTEXT.md` am Repo-Root, falls es existiert (aktuell nicht vorhanden — wird lazy vom `/domain-modeling`-Skill angelegt, sobald Begriffe/Entscheidungen geklärt werden).

## Entscheidungen (ADRs) — abweichend vom Standard-Layout

lokyy-brain nutzt **keine** lokalen `docs/adr/`. Gemäß der SSOT-Disziplin in `CLAUDE.md` werden alle Architektur-Entscheidungen als ADR-Notizen im externen **lokyy-vault** abgelegt:

- Pfad: `50_decisions/YYYY-MM-DD-lokyy-<slug>.md`
- Zugriff: über `search_vault` (MCP) bzw. die Brain-API — nicht über lokale Dateien in diesem Repo.
- Verlinkt vom Programm-Dach `[[10_projects/lokyy/README]]`.

**Vor jeder Aufgabe:** `search_vault` nach relevanten ADRs/Notizen befragen, bevor Code geändert oder eine Entscheidung getroffen wird. Nicht raten — steht es im Vault, ist das die Wahrheit; fehlt es, den User fragen.

**Nach jeder Aufgabe:** Neue Entscheidungen als ADR in `50_decisions/` im Vault dokumentieren (nicht in diesem Repo).

## Flag ADR-Konflikte

Widerspricht ein Output einer bestehenden Vault-ADR, das explizit benennen statt sie still zu überschreiben.

## Vokabular

Domain-Begriffe folgen `CLAUDE.md` (z. B. „Vault Contract", „SSOT", „Tier 1/2/3 Memory", „Brain vs. Lokyy OS"). Sobald `CONTEXT.md` existiert, hat dessen Glossar Vorrang.
