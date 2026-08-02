/**
 * Base-vault scaffold (Story 1.19).
 *
 * A fresh install used to produce a `.gitkeep` and four seed skills — no folder
 * structure at all, so the user landed in an effectively empty git repo. This
 * module produces the full canonical scaffold instead: folders, the live JSON
 * schemas, the SPEC, the note templates and the SPEC-enforcing pre-commit hook.
 *
 * Everything is DERIVED, never hand-listed a second time (AC#2/AC#3):
 *   - folders  ← `notes/folderMap.ts` (`TYPE_FOLDER`, via the profile registry)
 *                unioned with the documented roots in `conventions/index.ts`,
 *                so the scaffold cannot drift from the folders the write paths
 *                actually target,
 *   - schemas  ← the profile registry's schema objects, i.e. exactly the files
 *                in `frontmatter/schemas/` that `validateFrontmatter` compiles.
 *                A drift-guard test pins the emitted set against that directory.
 *
 * The hook / SPEC / templates are static assets that live next to this file
 * (`hooks/`, `templates/`, `SPEC.md`); they are copied into `dist/` by the
 * package build so the same relative `import.meta.url` lookup works from source
 * (vitest) and from the built server alike.
 *
 * This module is pure content generation — it writes nothing. The caller
 * (`server/src/setup/scaffoldVault.ts`) owns the filesystem + git side, mirroring
 * how `seedSkills()` is wired after provisioning. Deliberately NOT folded into
 * `provisionVaultDir`, which is shared with the tenant path (Story 1.13) and
 * must stay free of primary-vault concerns.
 *
 * Nothing is fetched at install time (AC#6): every byte below originates in
 * this repository.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import baseSchema from "../frontmatter/schemas/base.json" with { type: "json" };
import {
  DEFAULT_VAULT_PROFILE,
  VAULT_PROFILES,
  getProfileSpec,
  type VaultProfile,
} from "../frontmatter/profiles.js";
import { getVaultConventions } from "../conventions/index.js";

/** Directory git is pointed at via `core.hooksPath` in a scaffolded vault. */
export const VAULT_HOOKS_DIR = ".githooks";

/** Vault-relative install path of the SPEC-enforcing pre-commit hook. */
export const VAULT_HOOK_PATH = `${VAULT_HOOKS_DIR}/pre-commit`;

/** Where the machine-readable schemas land inside the vault. */
export const VAULT_SCHEMA_DIR = "00_meta/schemas";

/** One file the scaffold wants to exist in a fresh vault. */
export interface ScaffoldFile {
  /** Vault-relative path, POSIX separators. */
  path: string;
  /** Full file content. */
  content: string;
  /** True for files that must be chmod +x (the hook). */
  executable?: boolean;
}

/** Resolve an asset that ships next to this module (also present in `dist/`). */
function assetPath(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

/**
 * The folders a fresh vault of this profile gets.
 *
 * Union of (a) every folder the profile's `type → folder` map writes into and
 * (b) the documented roots `conventions/index.ts` advertises to agents — minus
 * any folder that belongs exclusively to a DIFFERENT profile. The conventions
 * surface intentionally shows PARA agents the karpathy layer too; materialising
 * `RAW/`, `Wiki/` and `Outputs/` in a PARA vault would be wrong, so they are
 * filtered out here rather than by hand-listing what to create.
 */
export function scaffoldFolders(
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): string[] {
  const own = new Set(Object.values(getProfileSpec(profile).typeFolder));
  const foreign = new Set<string>();
  for (const other of VAULT_PROFILES) {
    if (other === profile) continue;
    for (const folder of Object.values(getProfileSpec(other).typeFolder)) {
      foreign.add(folder);
    }
  }
  return getVaultConventions(profile)
    .folders.map((f) => f.path)
    .filter((path) => own.has(path) || !foreign.has(path));
}

/**
 * `filename → schema object` for every schema the code validates against.
 *
 * Built from the profile registry (all profiles, not just the active one) plus
 * `base.json`. A vault carries the complete schema library so the pre-commit
 * hook's `00_meta/schemas/<type>.json` lookup — its only source for the closed
 * type list — is complete; per-profile closure is enforced by the application's
 * `validateFrontmatter`, not by which files happen to be on disk.
 */
function schemaFiles(): Map<string, object> {
  const out = new Map<string, object>([["base.json", baseSchema as object]]);
  for (const profile of VAULT_PROFILES) {
    for (const [type, schema] of Object.entries(getProfileSpec(profile).schemas)) {
      out.set(`${type}.json`, schema);
    }
  }
  return out;
}

/** Markdown table of the scaffolded folders and what each is for. */
function renderFolderTable(profile: VaultProfile): string {
  const purposes = new Map(
    getVaultConventions(profile).folders.map((f) => [f.path, f.purpose]),
  );
  const rows = scaffoldFolders(profile).map(
    (path) => `| \`${path}\` | ${purposes.get(path) ?? "(Ordner)"} |`,
  );
  return ["| Ordner | Zweck |", "|---|---|", ...rows].join("\n");
}

/** Markdown table of the profile's closed doc-type list and its home folder. */
function renderTypeTable(profile: VaultProfile): string {
  const rows = getVaultConventions(profile).types.map(
    (t) => `| \`${t.type}\` | \`${t.folder}\` | ${t.meaning} |`,
  );
  return ["| type | Ordner | Bedeutung |", "|---|---|---|", ...rows].join("\n");
}

/**
 * Build the complete scaffold for a fresh vault of `profile`.
 *
 * Returns content only — idempotency (create-if-absent), chmod and the git
 * commit are the writer's job.
 */
export async function buildVaultScaffold(
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): Promise<ScaffoldFile[]> {
  const files: ScaffoldFile[] = [];

  // 1) The SPEC-enforcing hook. Executable, and only effective once the writer
  // points `core.hooksPath` at VAULT_HOOKS_DIR.
  files.push({
    path: VAULT_HOOK_PATH,
    content: await readFile(assetPath("./hooks/pre-commit"), "utf8"),
    executable: true,
  });

  // 2) SPEC.md with its folder/type tables rendered from the live conventions,
  // so the document a user reads matches the vault they actually got.
  const spec = await readFile(assetPath("./SPEC.md"), "utf8");
  files.push({
    path: "00_meta/SPEC.md",
    content: spec
      .replace("<!-- lokyy:folders -->", renderFolderTable(profile))
      .replace("<!-- lokyy:types -->", renderTypeTable(profile)),
  });

  // 3) Note templates — whatever ships in `templates/`, no second hand-kept list.
  const templateDir = assetPath("./templates/");
  for (const name of (await readdir(templateDir)).filter((f) => f.endsWith(".md")).sort()) {
    files.push({
      path: `00_meta/templates/${name}`,
      content: await readFile(templateDir + name, "utf8"),
    });
  }

  // 4) The live JSON schemas (AC#3) — the set the application validates against.
  for (const [name, schema] of [...schemaFiles()].sort(([a], [b]) => a.localeCompare(b))) {
    files.push({
      path: `${VAULT_SCHEMA_DIR}/${name}`,
      content: `${JSON.stringify(schema, null, 2)}\n`,
    });
  }

  // 5) A `.gitkeep` per folder — git does not track empty directories, so
  // without these the whole structure evaporates at commit time (same solution
  // the tenant scaffold in server/src/routes/tenants.ts already uses).
  for (const folder of scaffoldFolders(profile)) {
    files.push({ path: `${folder}/.gitkeep`, content: "" });
  }

  return files;
}
