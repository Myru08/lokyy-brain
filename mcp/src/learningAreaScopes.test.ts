import { describe, it, expect } from "vitest";
import { canRead, canWrite, applyRoleGate, type AgentScope } from "./scopes.js";
import { withMcpSession, type McpSession } from "./sessionContext.js";

/**
 * MCP-Scoping für das Modul `15_lerngebiete` (ADR-015).
 *
 * Das Scope-Modell ist glob-basiert und kennt KEINE per-Ordner-Allowlist im
 * Code — ein neuer Vault-Bereich braucht daher keine Code-Änderung an
 * `scopes.ts`. Diese Suite pinnt genau das: ein Agent, dem `15_lerngebiete/**`
 * zugestanden wurde, erreicht den Bereich (inkl. Unterstruktur) und NICHTS
 * darüber hinaus; ein Agent ohne diesen Eintrag erreicht ihn nicht.
 */

const LERN_AGENT: AgentScope = {
  readGlobs: ["15_lerngebiete/**/*.md", "10_projects/**/*.md"],
  writeGlobs: ["15_lerngebiete/**/*.md"],
  commitPrefix: "[agent:lerncoach]",
};

const session = (scope: AgentScope, role: McpSession["role"] = "write"): McpSession => ({
  vaultId: "vaultL",
  vaultDir: "/tmp/vaultL",
  agentId: "lerncoach",
  role,
  scope,
});

describe("15_lerngebiete — Scope-Durchsetzung (AC 15)", () => {
  it("erlaubt Lesen und Schreiben der Hub-Notiz und der Unterstruktur", () => {
    withMcpSession(session(LERN_AGENT), () => {
      for (const path of [
        "15_lerngebiete/rust-lernen.md",
        "15_lerngebiete/rust-lernen/lektionen/ownership.md",
        "15_lerngebiete/rust-lernen/lernnachweise/uebung-1.md",
        "15_lerngebiete/rust-lernen/referenzen/buch.md",
      ]) {
        expect(canRead(path), `read ${path}`).toBe(true);
        expect(canWrite(path), `write ${path}`).toBe(true);
      }
    });
  });

  it("gewährt KEINEN Schreibzugriff ausserhalb des Lerngebiets-Bereichs", () => {
    withMcpSession(session(LERN_AGENT), () => {
      // Lesen der Projekte ist zugestanden, Schreiben ausdrücklich nicht.
      expect(canRead("10_projects/cli-tool.md")).toBe(true);
      expect(canWrite("10_projects/cli-tool.md")).toBe(false);
      // Alles Übrige ist weder les- noch schreibbar (Default Deny).
      for (const path of [
        "20_notes/privat.md",
        "50_decisions/adr-015.md",
        "00_meta/mcp-scopes.yaml",
        "99_archive/_trash/alt.md",
      ]) {
        expect(canRead(path), `read ${path}`).toBe(false);
        expect(canWrite(path), `write ${path}`).toBe(false);
      }
    });
  });

  it("verhindert ein Ausbrechen über einen Prefix-Nachbarn", () => {
    withMcpSession(session(LERN_AGENT), () => {
      // `15_lerngebiete_privat` ist NICHT `15_lerngebiete` — der Glob-Match
      // ist segmentweise, nicht per String-Prefix.
      expect(canRead("15_lerngebiete_privat/geheim.md")).toBe(false);
      expect(canWrite("15_lerngebiete_privat/geheim.md")).toBe(false);
    });
  });

  it("degradiert eine read-Rolle auf Nur-Lesen im Lerngebiets-Bereich", () => {
    withMcpSession(session(applyRoleGate(LERN_AGENT, "read"), "read"), () => {
      expect(canRead("15_lerngebiete/rust-lernen.md")).toBe(true);
      expect(canWrite("15_lerngebiete/rust-lernen.md")).toBe(false);
    });
  });

  it("gibt der owner-Rolle den Bereich vollständig frei", () => {
    withMcpSession(session(applyRoleGate(LERN_AGENT, "owner"), "owner"), () => {
      expect(canRead("15_lerngebiete/rust-lernen.md")).toBe(true);
      expect(canWrite("15_lerngebiete/rust-lernen/lektionen/ownership.md")).toBe(true);
    });
  });

  it("sperrt einen Agenten OHNE 15_lerngebiete-Eintrag aus dem Bereich aus", () => {
    const andererAgent: AgentScope = {
      readGlobs: ["20_notes/**/*.md"],
      writeGlobs: ["20_notes/**/*.md"],
      commitPrefix: "[agent:notizen]",
    };
    withMcpSession(session(andererAgent), () => {
      expect(canRead("15_lerngebiete/rust-lernen.md")).toBe(false);
      expect(canWrite("15_lerngebiete/rust-lernen.md")).toBe(false);
    });
  });
});
