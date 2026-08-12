import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DOC_TYPES } from "../frontmatter/types.js";
import { validateFrontmatter, parseFrontmatter } from "../frontmatter/index.js";
import { getProfileSpec } from "../frontmatter/profiles.js";
import { TYPE_FOLDER, folderForType, checkPathMatchesType, isDatedType } from "./folderMap.js";
import { createManaged, resolveManagedCreate } from "./createManaged.js";
import { createNote, createFolder, getTree, moveEntry, trashEntry, getNote } from "./notesService.js";
import { getVaultConventions } from "../conventions/index.js";
import { buildVaultScaffold, scaffoldFolders } from "../vault/scaffold.js";
import { collectIndexFolders, renderVaultIndex, buildVaultIndexBody } from "../index/indexGenerator.js";
import { backlinks } from "../graph/graphService.js";
import { queryNotes } from "../dataview/index.js";
import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";

const exec = promisify(execFile);

/**
 * Modul `15_lerngebiete` / Doc-Type `learning-area` (ADR-015).
 *
 * Diese Suite pinnt die tragenden Zusagen des neuen Vault-Moduls:
 *   - `learning-area` ist ein vollwertiges Mitglied der geschlossenen
 *     PARA-Typliste und validiert gegen ein eigenes Schema mit gebundenem
 *     Status-Enum,
 *   - die Hub-Notiz landet auf dem kanonischen Pfad `15_lerngebiete/{slug}`
 *     (Variante A — KEIN Sonderfall in der Pfad-Maschinerie),
 *   - die Unterstruktur (`lektionen/` …) ist eine gewöhnliche Unterordner-
 *     Ablage unterhalb des kanonischen Ordners,
 *   - Scaffold, Index, Baum, Wikilinks und die Move/Trash-Invarianten
 *     verhalten sich exakt wie bei bestehenden Typen.
 *
 * Der Volltext-/Semantik-Index (Tier1 BM25, Tier2 Embeddings) hängt an
 * Postgres und wird in den `*.db.test.ts`-Suiten abgedeckt; hier steht
 * stellvertretend die dateisystembasierte `queryNotes`-Typfilterung, die der
 * MCP-`list_notes`-Filter benutzt.
 */

const ALL_STATUSES = ["draft", "active", "paused", "completed", "archived"] as const;

const VALID_BASE = {
  id: "01JXYZABCDEFGHJKMNPQRSTVWX",
  type: "learning-area" as const,
  title: "Rust lernen",
  created: "2026-08-12T10:00:00.000Z",
  updated: "2026-08-12T10:05:00.000Z",
};

/* ------------------------------------------------------------------ *
 *  1 + 2 — Typ-Mitgliedschaft und kanonische Ordner-Zuordnung
 * ------------------------------------------------------------------ */
describe("learning-area — Typ und Ordner (AC 1/2)", () => {
  it("ist Mitglied der geschlossenen PARA-Typliste", () => {
    expect(DOC_TYPES as readonly string[]).toContain("learning-area");
    expect(getProfileSpec("para").docTypes as readonly string[]).toContain("learning-area");
  });

  it("gehört NICHT zum karpathy-Profil (Profile bleiben disjunkt)", () => {
    expect(getProfileSpec("karpathy").docTypes as readonly string[]).not.toContain(
      "learning-area",
    );
  });

  it("zeigt auf 15_lerngebiete — in folderMap UND Profil-Registry (kein Drift)", () => {
    expect(TYPE_FOLDER["learning-area"]).toBe("15_lerngebiete");
    expect(folderForType("learning-area")).toBe("15_lerngebiete");
    expect(getProfileSpec("para").typeFolder["learning-area"]).toBe("15_lerngebiete");
  });

  it("ist ein statischer (nicht datierter) Typ — wie project", () => {
    expect(isDatedType("learning-area")).toBe(false);
  });

  it("erlaubt die Unterstruktur eines Lerngebiets unterhalb des Hub-Ordners", () => {
    for (const sub of ["lektionen", "referenzen", "lernnachweise", "dateien"]) {
      const check = checkPathMatchesType("learning-area", `15_lerngebiete/rust/${sub}/x`);
      expect(check.ok, `${sub} muss zulässig sein`).toBe(true);
    }
  });

  it("weist einen Pfad AUSSERHALB von 15_lerngebiete zurück", () => {
    const check = checkPathMatchesType("learning-area", "10_projects/rust");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.expectedFolder).toBe("15_lerngebiete");
  });

  it("wird in der Conventions-Oberfläche mit Ordner und Bedeutung geführt", () => {
    const conv = getVaultConventions("para");
    const entry = conv.types.find((t) => t.type === "learning-area");
    expect(entry).toBeDefined();
    expect(entry?.folder).toBe("15_lerngebiete");
    expect(entry?.meaning).toMatch(/Lerngebiet/i);
    const folder = conv.folders.find((f) => f.path === "15_lerngebiete");
    expect(folder).toBeDefined();
    // Variante A: das Pfadmuster ist das gewöhnliche {folder}/slug.
    expect(folder?.pathPattern).toBe("15_lerngebiete/slug");
  });
});

/* ------------------------------------------------------------------ *
 *  3 + 4 — Statuswerte validieren
 * ------------------------------------------------------------------ */
describe("learning-area — Schema und Statuswerte (AC 3/4)", () => {
  it("akzeptiert ein Lerngebiet ohne status (optional wie bei project)", () => {
    const res = validateFrontmatter(VALID_BASE, "learning-area");
    expect(res.valid).toBe(true);
  });

  it.each(ALL_STATUSES)("akzeptiert den gültigen Status %s", (status) => {
    const res = validateFrontmatter({ ...VALID_BASE, status }, "learning-area");
    expect(res.valid, JSON.stringify(res.errors)).toBe(true);
  });

  it("weist einen UNBEKANNTEN Statuswert ab (SPEC 3.3: wertgebunden)", () => {
    const res = validateFrontmatter({ ...VALID_BASE, status: "done" }, "learning-area");
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.keyword === "enum")).toBe(true);
  });

  it("weist ein Lerngebiet ohne Pflichtfelder ab", () => {
    const res = validateFrontmatter({ type: "learning-area" }, "learning-area");
    expect(res.valid).toBe(false);
  });

  it("weist eine falsch geformte ULID ab", () => {
    const res = validateFrontmatter({ ...VALID_BASE, id: "zu-kurz" }, "learning-area");
    expect(res.valid).toBe(false);
  });

  it("bindet den Typ fest — ein fremder type-Wert im learning-area-Schema fällt durch", () => {
    const res = validateFrontmatter({ ...VALID_BASE, type: "project" }, "learning-area");
    expect(res.valid).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 *  6 — Managed Creation: kanonischer Zielpfad (pure, ohne git)
 * ------------------------------------------------------------------ */
describe("resolveManagedCreate — Zielpfad eines Lerngebiets (AC 6)", () => {
  const FIXED = new Date("2026-08-12T12:00:00.000Z");

  it("leitet 15_lerngebiete/{slug} aus type + title ab (undatiert)", () => {
    const res = resolveManagedCreate({ title: "Rust lernen", type: "learning-area" }, FIXED);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.type).toBe("learning-area");
      expect(res.path).toBe("15_lerngebiete/rust-lernen");
      // Kein Datumspräfix — anders als capture/task.
      expect(res.path).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("faltet Umlaute/Diakritika im Slug (Titel bleibt unangetastet)", () => {
    const res = resolveManagedCreate(
      { title: "Steuerrecht für Selbständige", type: "learning-area" },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("15_lerngebiete/steuerrecht-fur-selbstandige");
      expect(res.title).toBe("Steuerrecht für Selbständige");
    }
  });

  it("honoriert einen folder_hint INNERHALB von 15_lerngebiete", () => {
    const res = resolveManagedCreate(
      { title: "Ownership", type: "learning-area", folder_hint: "15_lerngebiete/rust" },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("15_lerngebiete/rust/ownership");
  });

  it("IGNORIERT einen folder_hint, der aus 15_lerngebiete ausbricht", () => {
    const res = resolveManagedCreate(
      { title: "Sneaky", type: "learning-area", folder_hint: "10_projects" },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("15_lerngebiete/sneaky");
  });

  it("wehrt Path-Traversal im folder_hint ab", () => {
    const res = resolveManagedCreate(
      {
        title: "Evil",
        type: "learning-area",
        folder_hint: "15_lerngebiete/../50_decisions",
      },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("15_lerngebiete/evil");
      expect(res.path).not.toContain("..");
      expect(res.path).not.toContain("50_decisions");
    }
  });
});

/* ------------------------------------------------------------------ *
 *  7 + 8 — Scaffold: Ordner, Schema, Template; Bestand unverändert
 * ------------------------------------------------------------------ */
describe("Scaffold eines frischen Vaults (AC 7/8)", () => {
  it("legt 15_lerngebiete als Ordner an", async () => {
    expect(scaffoldFolders("para")).toContain("15_lerngebiete");
    const files = await buildVaultScaffold("para");
    expect(files.map((f) => f.path)).toContain("15_lerngebiete/.gitkeep");
  });

  it("liefert das learning-area JSON-Schema mit ins 00_meta/schemas", async () => {
    const files = await buildVaultScaffold("para");
    const schema = files.find((f) => f.path === "00_meta/schemas/learning-area.json");
    expect(schema).toBeDefined();
    const parsed = JSON.parse(schema!.content);
    expect(parsed.properties.type.const).toBe("learning-area");
    expect(parsed.properties.status.enum).toEqual([...ALL_STATUSES]);
  });

  it("liefert das Lerngebiets-Template mit den fachlichen Abschnitten", async () => {
    const files = await buildVaultScaffold("para");
    const tpl = files.find((f) => f.path === "00_meta/templates/learning-area.md");
    expect(tpl).toBeDefined();
    for (const section of [
      "Mission",
      "Erfolgskriterien",
      "Vorwissen",
      "Aktueller Lernstand",
      "Nächster Schritt",
      "Blocker",
      "Nicht Bestandteil",
      "Lektionen",
      "Lernnachweise",
      "Quellen und Referenzen",
      "Verknüpfte Projekte",
    ]) {
      expect(tpl!.content, `Abschnitt "${section}" fehlt`).toContain(`## ${section}`);
    }
    // Der Status-Startwert des Templates muss zum Schema-Enum passen.
    expect(tpl!.content).toContain("type: learning-area");
    expect(tpl!.content).toMatch(/status: draft/);
  });

  it("nennt 15_lerngebiete in der generierten SPEC-Ordnertabelle", async () => {
    const files = await buildVaultScaffold("para");
    const spec = files.find((f) => f.path === "00_meta/SPEC.md");
    expect(spec!.content).toContain("`15_lerngebiete`");
    expect(spec!.content).toContain("`learning-area`");
  });

  it("lässt die BESTEHENDEN Typen und ihre Ordner unverändert (AC 8)", async () => {
    // Stichprobe der tragenden Alt-Zuordnungen — ein Regress hier hieße, das
    // neue Modul hätte bestehende Vaults umgeroutet.
    expect(folderForType("note")).toBe("20_notes");
    expect(folderForType("project")).toBe("10_projects");
    expect(folderForType("decision")).toBe("50_decisions");
    expect(folderForType("capture")).toBe("30_captures");
    expect(isDatedType("capture")).toBe(true);

    const folders = scaffoldFolders("para");
    for (const legacy of ["00_meta", "10_projects", "20_notes", "30_captures", "99_archive"]) {
      expect(folders, `Alt-Ordner ${legacy} verschwunden`).toContain(legacy);
    }
    // Das karpathy-Profil bleibt von dem PARA-Modul unberührt.
    expect(scaffoldFolders("karpathy")).not.toContain("15_lerngebiete");
  });
});

/* ------------------------------------------------------------------ *
 *  10 — Deterministischer Index (rein, ohne Vault)
 * ------------------------------------------------------------------ */
describe("Deterministischer Vault-Index — reine Render-Ebene (AC 10)", () => {
  const tree = [
    {
      type: "folder" as const,
      name: "15_lerngebiete",
      path: "15_lerngebiete",
      children: [
        { type: "note" as const, name: "Rust lernen", path: "15_lerngebiete/rust-lernen", children: [] },
        {
          type: "folder" as const,
          name: "rust-lernen",
          path: "15_lerngebiete/rust-lernen",
          children: [
            {
              type: "folder" as const,
              name: "lektionen",
              path: "15_lerngebiete/rust-lernen/lektionen",
              children: [
                {
                  type: "note" as const,
                  name: "Ownership",
                  path: "15_lerngebiete/rust-lernen/lektionen/ownership",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  it("erfasst den Bereich und die verschachtelte Lektions-Ebene automatisch", () => {
    const folders = collectIndexFolders(tree as never);
    const paths = folders.map((f) => f.path);
    expect(paths).toContain("15_lerngebiete");
    expect(paths).toContain("15_lerngebiete/rust-lernen/lektionen");
  });

  it("rendert Hub-Notiz und Lektion mit ihren Pfaden", () => {
    const out = renderVaultIndex(collectIndexFolders(tree as never));
    expect(out).toContain("`15_lerngebiete/rust-lernen`");
    expect(out).toContain("`15_lerngebiete/rust-lernen/lektionen/ownership`");
  });
});

/* ------------------------------------------------------------------ *
 *  5, 9, 10, 12, 13, 14 — gegen einen echten, isolierten Vault
 * ------------------------------------------------------------------ */
async function setupTestVault(): Promise<{ workdir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-lerngebiet-test-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "lokyy-test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "lokyy-test",
    GIT_COMMITTER_EMAIL: "test@localhost",
  };
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], { env: gitEnv });
  await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
  await exec("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });

  initCore({ vaultDir: workdir, gitRemote: remote, gitBranch: "main" });
  await ensureRepo();
  return { workdir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

describe("Lerngebiet im echten Vault (AC 5/9/10/12/13/14)", () => {
  let vault: { workdir: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    vault = await setupTestVault();
  }, 30_000);

  afterAll(async () => {
    await vault.cleanup();
  });

  it("erzeugt über create_managed_note ULID, Zeitstempel und gültiges Frontmatter (AC 5)", async () => {
    const res = await createManaged({
      title: "Rust lernen",
      body: "## Mission\n\nSystemnah programmieren lernen.\n",
      type: "learning-area",
      tags: ["rust"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // AC 6 — der Zielpfad wird abgeleitet, nicht vom Client diktiert.
    expect(res.note.path).toBe("15_lerngebiete/rust-lernen.md");
    await expect(stat(join(vault.workdir, "15_lerngebiete", "rust-lernen.md"))).resolves.toBeDefined();

    const { data } = parseFrontmatter(res.note.body);
    expect(data.type).toBe("learning-area");
    expect(data.title).toBe("Rust lernen");
    expect(typeof data.id).toBe("string");
    expect((data.id as string)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(data.created).toBeDefined();
    expect(data.updated).toBeDefined();
    expect(data.tags).toEqual(["rust"]);

    // Das erzeugte Frontmatter validiert gegen das eigene Schema.
    expect(validateFrontmatter(data, "learning-area").valid).toBe(true);
  });

  it("nimmt die Unterstruktur eines Lerngebiets an (lektionen/…)", async () => {
    for (const sub of ["lektionen", "referenzen", "lernnachweise", "dateien"]) {
      await createFolder(`15_lerngebiete/rust-lernen/${sub}`);
    }
    // Verlinkt per Notiz-ID auf die Hub-Notiz — die Form, die `backlinks()`
    // ohne H1-Überschrift im Ziel auflöst.
    const lektion = await createNote(
      "15_lerngebiete/rust-lernen/lektionen/ownership",
      "Ownership erklärt das Speichermodell. Siehe [[15_lerngebiete/rust-lernen]].",
      { title: "Ownership", type: "note", validatePlacement: false },
    );
    expect(lektion.path).toBe("15_lerngebiete/rust-lernen/lektionen/ownership.md");
  });

  it("zeigt den Bereich im Vault-Baum — Grundlage von list_tree (AC 9)", async () => {
    const tree = await getTree();
    const area = tree.find((n) => n.path === "15_lerngebiete");
    expect(area, "15_lerngebiete fehlt im Baum").toBeDefined();
    expect(area?.type).toBe("folder");
  });

  it("führt Bereich und Lerngebiet im deterministischen Index (AC 10)", async () => {
    const body = await buildVaultIndexBody({
      getTree,
      getNote: async (id: string) => {
        const n = await getNote(id);
        return n ? { body: n.body } : null;
      },
    });
    expect(body).toContain("15_lerngebiete");
    expect(body).toContain("`15_lerngebiete/rust-lernen`");
    expect(body).toContain("`15_lerngebiete/rust-lernen/lektionen/ownership`");
  });

  it("findet Lerngebiete über den Typfilter — Grundlage von list_notes (AC 12)", async () => {
    const rows = await queryNotes({ where: { type: "learning-area" }, select: ["id", "type"] });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type === "learning-area")).toBe(true);
    expect(rows.map((r) => r.id)).toContain("15_lerngebiete/rust-lernen");

    // Der Filter trennt sauber: die Lektion ist type:note, kein Lerngebiet.
    expect(rows.map((r) => r.id)).not.toContain(
      "15_lerngebiete/rust-lernen/lektionen/ownership",
    );
  });

  it("filtert Lerngebiete zusätzlich nach Ordner-Prefix", async () => {
    const rows = await queryNotes({ from: "15_lerngebiete", select: ["id", "type"] });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("15_lerngebiete/rust-lernen");
    // Der Prefix-Match ist segmentweise und zieht die Unterstruktur mit.
    expect(ids).toContain("15_lerngebiete/rust-lernen/lektionen/ownership");
  });

  it("löst Wikilinks aus einer Lektion auf das Lerngebiet auf (AC 13)", async () => {
    // Backlinks eines Lerngebiets entstehen aus der GEWÖHNLICHEN Wikilink-
    // Logik — keine Sonderbehandlung, kein Auto-Verlinken per Wortähnlichkeit.
    const links = await backlinks("15_lerngebiete/rust-lernen");
    const sources = links.map((b) => b.noteId);
    expect(sources).toContain("15_lerngebiete/rust-lernen/lektionen/ownership");
    // Der Kontext-Ausschnitt wird wie bei jeder anderen Notiz mitgeliefert.
    expect(links.find((b) => b.noteId.endsWith("/ownership"))?.context).toContain("[[");
  });

  it("verlinkt aus einem Lerngebiet heraus auf ein Projekt (AC 13)", async () => {
    // `backlinks()` löst gegen die H1-Überschrift des Ziels ODER dessen id auf.
    await createNote("10_projects/cli-tool", "# CLI Tool\n\nEin Projekt.", {
      title: "CLI Tool",
      type: "project",
      validatePlacement: true,
    });
    await createManaged({
      title: "Nebenlaeufigkeit",
      body: "Angewendet in [[CLI Tool]].",
      type: "learning-area",
    });
    const links = await backlinks("10_projects/cli-tool");
    expect(links.map((b) => b.noteId)).toContain("15_lerngebiete/nebenlaeufigkeit");
  });

  it("hält ULID und Typ über move/rename stabil (AC 14)", async () => {
    const before = await getNote("15_lerngebiete/nebenlaeufigkeit");
    const idBefore = parseFrontmatter(before!.body).data.id;

    await moveEntry("15_lerngebiete/nebenlaeufigkeit", "15_lerngebiete/nebenlaeufigkeit-rust", "note");

    const after = await getNote("15_lerngebiete/nebenlaeufigkeit-rust");
    expect(after, "verschobenes Lerngebiet nicht auffindbar").not.toBeNull();
    const dataAfter = parseFrontmatter(after!.body).data;
    // Die ULID — nicht der Pfad — ist die Identität (SPEC 8).
    expect(dataAfter.id).toBe(idBefore);
    expect(dataAfter.type).toBe("learning-area");
    // Der alte Pfad ist weg.
    expect(await getNote("15_lerngebiete/nebenlaeufigkeit")).toBeNull();
  });

  it("archiviert ein Lerngebiet per Soft-Delete in den Trash (AC 14)", async () => {
    const before = await getNote("15_lerngebiete/nebenlaeufigkeit-rust");
    const idBefore = parseFrontmatter(before!.body).data.id;

    const res = await trashEntry("15_lerngebiete/nebenlaeufigkeit-rust");
    expect(res.to).toMatch(/^99_archive\/_trash\//);

    // Aus dem Lerngebiets-Bereich verschwunden, im Trash erhalten — inkl. ULID.
    expect(await getNote("15_lerngebiete/nebenlaeufigkeit-rust")).toBeNull();
    const trashed = await getNote(res.to);
    expect(trashed).not.toBeNull();
    expect(parseFrontmatter(trashed!.body).data.id).toBe(idBefore);
  });

  it("weist eine Lerngebiets-Notiz ausserhalb von 15_lerngebiete ab (Platzierungs-Guard)", async () => {
    await expect(
      createNote("20_notes/falsch-abgelegt", "x", {
        title: "Falsch abgelegt",
        type: "learning-area",
        validatePlacement: true,
      }),
    ).rejects.toThrow();
  });
});
