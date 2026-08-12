/**
 * Vault-SPEC-Profile (Story S2, Entscheidung B1).
 *
 * Ein SPEC-Profil kapselt das, was bisher global hartkodiert war:
 *   - die Liste gültiger Doc-Typen,
 *   - die `type → Ordner`-Map (Heimat jeder Notiz),
 *   - das Schema-Set (per-type ajv-Schema-Objekte).
 *
 * Zwei Profile:
 *   - `para`     — Default. Exakt heutiges Verhalten: 15 PARA-Typen, `TYPE_FOLDER`,
 *                  die bestehenden per-type-Schemas. KEINE Verhaltensänderung.
 *   - `karpathy` — RAW/Wiki/Outputs (`raw-source`/`wiki-article`/`frage-report`)
 *                  mit den drei neuen Schemas und der Ordner-Map
 *                  `raw-source→RAW`, `wiki-article→Wiki`, `frage-report→Outputs`.
 *
 * Die Registry ist absichtlich klein — nur Daten + ein Auflöser. KEIN Refactor
 * der bestehenden PARA-Konstanten über das Nötige hinaus. Das aktive Profil wird
 * pro Vault aufgelöst (`resolveVaultProfile`), Default `para`, sodass server/mcp
 * ohne Signaturänderung weiterlaufen.
 */

import {
  DOC_TYPES,
  KARPATHY_DOC_TYPES,
  type AnyDocType,
} from "./types.js";

// PARA per-type schema objects (the existing 15).
import noteSchema from "./schemas/note.json" with { type: "json" };
import captureSchema from "./schemas/capture.json" with { type: "json" };
import projectSchema from "./schemas/project.json" with { type: "json" };
import taskSchema from "./schemas/task.json" with { type: "json" };
import decisionSchema from "./schemas/decision.json" with { type: "json" };
import meetingSchema from "./schemas/meeting.json" with { type: "json" };
import customerSchema from "./schemas/customer.json" with { type: "json" };
import workflowSchema from "./schemas/workflow.json" with { type: "json" };
import interventionSchema from "./schemas/intervention.json" with { type: "json" };
import contentSchema from "./schemas/content.json" with { type: "json" };
import peerSchema from "./schemas/peer.json" with { type: "json" };
import skillSchema from "./schemas/skill.json" with { type: "json" };
import toolSchema from "./schemas/tool.json" with { type: "json" };
import resourceSchema from "./schemas/resource.json" with { type: "json" };
import referenceSchema from "./schemas/reference.json" with { type: "json" };
import learningAreaSchema from "./schemas/learning-area.json" with { type: "json" };

// Karpathy per-type schema objects (Story S2, the three new ones).
import rawSourceSchema from "./schemas/raw-source.json" with { type: "json" };
import wikiArticleSchema from "./schemas/wiki-article.json" with { type: "json" };
import frageReportSchema from "./schemas/frage-report.json" with { type: "json" };

/** Closed list of SPEC-profile identifiers. */
export const VAULT_PROFILES = ["para", "karpathy"] as const;
export type VaultProfile = (typeof VAULT_PROFILES)[number];

/** The default profile when nothing is configured (legacy / PARA). */
export const DEFAULT_VAULT_PROFILE: VaultProfile = "para";

/** A profile's full definition: its types, type→folder map, and schema set. */
export interface VaultProfileSpec {
  /** Profile identifier. */
  profile: VaultProfile;
  /** Closed list of doc types this profile accepts. */
  docTypes: readonly AnyDocType[];
  /** `type → folder` map for this profile's types. */
  typeFolder: Readonly<Record<string, string>>;
  /** `type → JSON-schema object` for ajv compilation. */
  schemas: Readonly<Record<string, object>>;
}

/**
 * PARA `type → folder` map. Mirrors `notes/folderMap.ts` `TYPE_FOLDER` exactly
 * (single source remains folderMap; this is the profile-shaped view of it).
 * Kept local to avoid a circular import (folderMap imports from `./types`,
 * conventions imports folderMap). The folderMap test + the profile test both
 * pin this against `TYPE_FOLDER`, so drift fails the build.
 */
const PARA_TYPE_FOLDER: Readonly<Record<string, string>> = {
  note: "20_notes",
  capture: "30_captures",
  project: "10_projects",
  task: "40_tasks",
  decision: "50_decisions",
  meeting: "60_meetings",
  customer: "40_customers",
  workflow: "70_pai/workflows",
  intervention: "70_pai/interventions",
  content: "80_brand",
  peer: "70_pai/peers",
  skill: "70_pai/skills",
  tool: "35_tools",
  resource: "30_captures",
  reference: "20_notes",
  "learning-area": "15_lerngebiete",
} as const;

const PARA_SCHEMAS: Readonly<Record<string, object>> = {
  note: noteSchema as object,
  capture: captureSchema as object,
  project: projectSchema as object,
  task: taskSchema as object,
  decision: decisionSchema as object,
  meeting: meetingSchema as object,
  customer: customerSchema as object,
  workflow: workflowSchema as object,
  intervention: interventionSchema as object,
  content: contentSchema as object,
  peer: peerSchema as object,
  skill: skillSchema as object,
  tool: toolSchema as object,
  resource: resourceSchema as object,
  reference: referenceSchema as object,
  "learning-area": learningAreaSchema as object,
};

/**
 * Karpathy `type → folder` map (Story S2 §3). Definition only — no routing
 * change, no migration. The PARA routing machinery is untouched.
 */
export const KARPATHY_TYPE_FOLDER: Readonly<Record<string, string>> = {
  "raw-source": "RAW",
  "wiki-article": "Wiki",
  "frage-report": "Outputs",
} as const;

const KARPATHY_SCHEMAS: Readonly<Record<string, object>> = {
  "raw-source": rawSourceSchema as object,
  "wiki-article": wikiArticleSchema as object,
  "frage-report": frageReportSchema as object,
};

/** The profile registry — one entry per `VaultProfile`. */
const REGISTRY: Readonly<Record<VaultProfile, VaultProfileSpec>> = {
  para: {
    profile: "para",
    docTypes: DOC_TYPES,
    typeFolder: PARA_TYPE_FOLDER,
    schemas: PARA_SCHEMAS,
  },
  karpathy: {
    profile: "karpathy",
    docTypes: KARPATHY_DOC_TYPES,
    typeFolder: KARPATHY_TYPE_FOLDER,
    schemas: KARPATHY_SCHEMAS,
  },
};

/** True when `value` is a known profile identifier. */
export function isVaultProfile(value: unknown): value is VaultProfile {
  return (
    typeof value === "string" &&
    (VAULT_PROFILES as readonly string[]).includes(value)
  );
}

/** Look up a profile spec; unknown profile falls back to the PARA default. */
export function getProfileSpec(
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): VaultProfileSpec {
  return REGISTRY[profile] ?? REGISTRY[DEFAULT_VAULT_PROFILE];
}

/**
 * Resolve the active SPEC-profile for a vault.
 *
 * Resolution order (most specific wins), all optional, Default `para`:
 *   1. explicit `profile` argument (used by tests / call-sites that already
 *      know the vault profile),
 *   2. `LOKYY_VAULT_PROFILE` env var (single-vault deployments),
 *   3. `LOKYY_VAULT_PROFILE_<VAULTID>` env var (per-vault override in a
 *      multi-vault deployment; vaultId upper-cased, non-alnum → `_`),
 *   4. the PARA default.
 *
 * Kept env-driven + tiny on purpose: persisting profile-per-vault in the DB /
 * vault config is a follow-up; this gives a working, abwärtskompatibler hook
 * today without touching MemoryProvider/Index/get_health.
 */
export function resolveVaultProfile(opts?: {
  profile?: VaultProfile | string | null;
  vaultId?: string | null;
}): VaultProfile {
  if (opts?.profile && isVaultProfile(opts.profile)) return opts.profile;

  const vaultId = opts?.vaultId;
  if (vaultId) {
    const key = `LOKYY_VAULT_PROFILE_${vaultId
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_")}`;
    const perVault = process.env[key];
    if (isVaultProfile(perVault)) return perVault;
  }

  const global = process.env.LOKYY_VAULT_PROFILE;
  if (isVaultProfile(global)) return global;

  return DEFAULT_VAULT_PROFILE;
}
