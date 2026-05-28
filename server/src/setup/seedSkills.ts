import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  generateUlid,
  serializeFrontmatter,
  validateFrontmatter,
  save as gitSave,
  FrontmatterValidationError,
  type FrontmatterMap,
} from "@lokyy/core";
import { config } from "../config.js";

/**
 * Story 9-5 — Seed-Skills im Vault-Scaffold.
 *
 * Schreibt vier fertige `type: skill`-Notes unter `70_pai/skills/` in einen
 * frisch provisionierten Vault, damit Skills ab Tag eins nutzbar sind. Wird
 * vom Setup-Wizard (`POST /api/setup/vault`) NACH erfolgreichem Vault-
 * Provisioning aufgerufen.
 *
 * Invariante (AC#6): idempotentes create-if-absent — existiert die Ziel-
 * Datei bereits, wird sie NICHT überschrieben. So überlebt ein vom User
 * editierter Skill ein Re-Init.
 *
 * Geschrieben wird über `gitService.save` (write → add → commit → pull
 * --rebase → push), damit der lokyy-vault Pre-Commit-Hook das Frontmatter
 * validiert und Forgejo die Wahrheit aktualisiert.
 */

/** Wo die Seed-Skills im Vault landen. */
const SKILLS_DIR = "70_pai/skills";

/**
 * Eine Seed-Definition ohne die laufzeit-generierten Felder (`id`,
 * `created`, `updated`) — diese werden pro Seed-Lauf frisch erzeugt.
 */
interface SeedSkill {
  /** Dateiname ohne `.md`, zugleich der `skill_name`. */
  slug: string;
  frontmatter: Omit<FrontmatterMap, "id" | "type" | "created" | "updated">;
  body: string;
}

const SEED_SKILLS: SeedSkill[] = [
  {
    slug: "wochenrueckblick",
    frontmatter: {
      title: "Wochenrückblick",
      skill_name: "wochenrueckblick",
      description:
        "Erstellt eine periodische Zusammenfassung der Notizen der letzten Tage und legt sie als Digest ab.",
      execution: "client",
      allowed_tools: ["search_vault", "read_note", "create_note"],
      input_schema: {
        type: "object",
        properties: {
          days: {
            type: "integer",
            description: "Wie viele Tage zurück betrachtet werden.",
            default: 7,
          },
        },
      },
      output: {
        folder: "70_pai/digests",
        type: "note",
        path_pattern: "70_pai/digests/{{today}}-wochenrueckblick",
      },
      tags: ["skill", "digest"],
    },
    body: `# Wochenrückblick

Du bist ein Reflexions-Assistent. Erstelle einen Wochenrückblick über die letzten {{days}} Tage.

## Vorgehen

1. Nutze \`search_vault\`, um Notizen zu finden, die in den letzten {{days}} Tagen erstellt oder geändert wurden (Stichtag: {{today}}).
2. Lies die relevantesten Treffer mit \`read_note\`.
3. Fasse zusammen:
   - **Was ist passiert** — die wichtigsten Themen und Ereignisse.
   - **Entscheidungen** — getroffene oder offene Entscheidungen.
   - **Lose Enden** — was offen blieb und nächste Woche Aufmerksamkeit braucht.
4. Verlinke die zugrunde liegenden Notizen als \`[[Wikilinks]]\`.

## Ausgabe

Lege das Ergebnis mit \`create_note\` unter \`70_pai/digests/{{today}}-wochenrueckblick\` (type \`note\`) ab. Schreibe auf Deutsch, kompakt, mit klaren Überschriften.
`,
  },
  {
    slug: "capture-to-todos",
    frontmatter: {
      title: "Capture zu To-dos",
      skill_name: "capture-to-todos",
      description:
        "Veredelt rohe Captures aus 30_captures/ zu konkreten, umsetzbaren Aufgaben (type: task).",
      execution: "client",
      allowed_tools: ["search_vault", "read_note", "create_note"],
      input_schema: {
        type: "object",
        properties: {
          capture_id: {
            type: "string",
            description:
              "Optional: ID/Pfad eines konkreten Captures. Ohne Angabe werden offene Captures gesucht.",
          },
        },
      },
      output: {
        folder: "40_tasks",
        type: "task",
        path_pattern: "40_tasks/{{today}}-{{slug}}",
      },
      tags: ["skill", "task"],
    },
    body: `# Capture zu To-dos

Du bist ein Produktivitäts-Assistent. Wandle rohe Captures in klar umsetzbare Aufgaben um.

## Vorgehen

1. Quelle bestimmen:
   - Ist \`{{capture_id}}\` gesetzt, lies genau diesen Capture mit \`read_note\`.
   - Sonst nutze \`search_vault\`, um unverarbeitete Captures in \`30_captures/\` zu finden.
2. Extrahiere für jeden Capture die konkreten Handlungen — eine Aufgabe pro klar abgegrenzter Tätigkeit.
3. Formuliere jede Aufgabe als Verb-Phrase ("X erledigen", nicht "X").
4. Verlinke die Quelle als \`[[Wikilink]]\` zurück auf den Capture.

## Ausgabe

Lege jede Aufgabe mit \`create_note\` als \`type: task\` an. Schreibe auf Deutsch. Keine vagen To-dos — jede Aufgabe muss in einem Schritt startbar sein.
`,
  },
  {
    slug: "zk-steward",
    frontmatter: {
      title: "Zettelkasten-Steward",
      skill_name: "zk-steward",
      description:
        "Pflegt den Knowledge-Graph: findet verwaiste Notizen und fehlende Wikilinks und schlägt Verbindungen vor.",
      execution: "client",
      allowed_tools: ["search_vault", "read_note", "list_tree", "update_note"],
      input_schema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Optional: ein Thema/Stichwort, auf das die Pflege fokussiert werden soll.",
          },
        },
      },
      output: {
        folder: "70_pai/interventions",
        type: "intervention",
      },
      tags: ["skill", "graph"],
    },
    body: `# Zettelkasten-Steward

Du bist ein Knowledge-Graph-Gärtner. Halte den Vault gut vernetzt.

## Vorgehen

1. Verschaffe dir mit \`list_tree\` einen Überblick über die Struktur.
2. Nutze \`search_vault\` (ggf. fokussiert auf \`{{topic}}\`), um inhaltlich verwandte Notizen zu finden, die noch NICHT per \`[[Wikilink]]\` verbunden sind.
3. Lies Kandidaten mit \`read_note\` und prüfe, ob eine Verbindung wirklich sinnvoll ist — keine Link-Inflation.
4. Wo eine Verbindung klar fehlt, ergänze sie mit \`update_note\`, indem du an passender Stelle ein \`[[Ziel-Notiz]]\` einfügst.

## Ausgabe

Fasse die vorgeschlagenen bzw. gesetzten Verbindungen als kurze Begründung zusammen. Schreibe auf Deutsch. Verändere niemals den Sinn einer Notiz — du fügst nur Verknüpfungen hinzu.
`,
  },
  {
    slug: "research-capture",
    frontmatter: {
      title: "Research-Capture",
      skill_name: "research-capture",
      description:
        "Recherchiert ein Thema und legt das Ergebnis als Capture-Note in 30_captures/ ab.",
      execution: "client",
      allowed_tools: ["search_vault", "create_note"],
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Das Thema bzw. die Frage, zu der recherchiert werden soll.",
            required: true,
          },
        },
        required: ["query"],
      },
      output: {
        folder: "30_captures",
        type: "capture",
        path_pattern: "30_captures/{{today}}-{{slug}}",
      },
      tags: ["skill", "research", "capture"],
    },
    body: `# Research-Capture

Du bist ein Recherche-Assistent. Sammle externes Wissen zu einer Frage und sichere es im Vault.

## Vorgehen

1. Prüfe zuerst mit \`search_vault\`, ob es zu \`{{query}}\` bereits Notizen gibt — dann ergänzt du nur Lücken statt Dubletten zu erzeugen.
2. Recherchiere \`{{query}}\` aus zuverlässigen Quellen.
3. Destilliere die Kernaussagen auf das Wesentliche — Fakten, Zahlen, Zitate mit Quellenangabe.

## Ausgabe

Lege das Ergebnis mit \`create_note\` als \`type: capture\` unter \`30_captures/{{today}}-{{slug}}\` ab. Schreibe auf Deutsch. Nenne immer die Quellen; markiere Unsicheres als solches.
`,
  },
];

/** Pluggable file-writer — production uses `gitService.save`. */
export type SkillWriter = (
  relPath: string,
  content: string,
  message: string,
) => Promise<unknown>;

/** Pluggable existence-check — production uses `fs.stat` against `vaultDir`. */
export type ExistsCheck = (relPath: string) => Promise<boolean>;

export interface SeedSkillsOptions {
  /** Vault-Root für die Existenzprüfung. Default: `config.vaultDir`. */
  vaultDir?: string;
  /** Writer. Default: `gitService.save` (commit + push über Forgejo). */
  writer?: SkillWriter;
  /** Existenzprüfung. Default: `fs.stat` relativ zu `vaultDir`. */
  exists?: ExistsCheck;
  /** ULID-Generator. Default: `generateUlid` (für Tests injizierbar). */
  ulid?: () => string;
}

export interface SeedSkillResult {
  slug: string;
  relPath: string;
  /** "created" wenn neu geschrieben, "skipped" wenn bereits vorhanden. */
  status: "created" | "skipped";
}

async function defaultExists(vaultDir: string, relPath: string): Promise<boolean> {
  try {
    await stat(join(vaultDir, relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Baut das vollständige, schema-valide Frontmatter für einen Seed-Skill.
 * Exportiert, damit Tests jede Definition isoliert validieren können.
 */
export function buildSkillFrontmatter(
  seed: SeedSkill,
  ulid: () => string = generateUlid,
): FrontmatterMap {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    type: "skill",
    created: now,
    updated: now,
    ...seed.frontmatter,
  };
}

/** Alle Seed-Definitionen (Read-only) — für Tests + Introspektion. */
export const seedSkillDefinitions: ReadonlyArray<SeedSkill> = SEED_SKILLS;

/**
 * Schreibt die vier Seed-Skills idempotent in den Vault. Existierende
 * Dateien werden NICHT überschrieben. Validiert jedes Frontmatter gegen das
 * `skill`-Schema, bevor geschrieben wird — ein invalider Seed würde sonst
 * den Vault-Pre-Commit-Hook auslösen.
 */
export async function seedSkills(
  opts: SeedSkillsOptions = {},
): Promise<SeedSkillResult[]> {
  const vaultDir = opts.vaultDir ?? config.vaultDir;
  const writer: SkillWriter = opts.writer ?? gitSave;
  const exists: ExistsCheck =
    opts.exists ?? ((relPath) => defaultExists(vaultDir, relPath));
  const ulid = opts.ulid ?? generateUlid;

  const results: SeedSkillResult[] = [];

  for (const seed of SEED_SKILLS) {
    const relPath = `${SKILLS_DIR}/${seed.slug}.md`;

    // AC#6: create-if-absent — nie eine vorhandene (ggf. user-editierte) Datei
    // überschreiben.
    if (await exists(relPath)) {
      results.push({ slug: seed.slug, relPath, status: "skipped" });
      continue;
    }

    const frontmatter = buildSkillFrontmatter(seed, ulid);
    const validation = validateFrontmatter(frontmatter, "skill");
    if (!validation.valid) {
      throw new FrontmatterValidationError({
        message: `Seed-Skill "${seed.slug}" hat invalides Frontmatter.`,
        noteId: (frontmatter.id as string) ?? null,
        errors: validation.errors,
      });
    }

    const content = serializeFrontmatter(frontmatter, seed.body);
    await writer(relPath, content, `seed-skill angelegt: ${seed.slug}`);
    results.push({ slug: seed.slug, relPath, status: "created" });
  }

  return results;
}
