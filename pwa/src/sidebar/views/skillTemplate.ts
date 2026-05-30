/**
 * skillTemplate — reine, dependency-freie Vorlagen-/Frontmatter-Generierung
 * für „Neuer Skill per Vorlage" (Skill-Bibliothek).
 *
 * BEWUSST KEINE React-/DOM-/Netzwerk-Abhängigkeit: Diese Datei nimmt die
 * Roh-Eingaben aus dem Dialog und produziert (a) den Vault-Pfad und (b) das
 * vollständige Markdown (YAML-Frontmatter + Body) einer SPEC-validen
 * `type: skill`-Note. So lässt sich die Generierung als Vitest isoliert
 * prüfen (PFLICHT), ohne UI oder Server zu mocken.
 *
 * Schreibweg (Addendum §0 — nur bestehende HTTP-API, kein @lokyy/core im
 * Bundle): Der erzeugte String geht über `api.putNote(path, markdown)`. Der
 * Server-`saveNote` parst das mitgelieferte Frontmatter, übernimmt
 * `type: skill` + die übrigen Felder und INJIZIERT selbst `id` (ULID),
 * `created` und `updated`. Darum trägt die Vorlage diese drei Felder NICHT —
 * sie würden ohnehin vom Server überschrieben/erzeugt.
 *
 * Skill-Schema (get_skill_schema): required = id, type, title, skill_name,
 * description, created, updated. Optional: execution ("client"|"server",
 * default client), allowed_tools[], input_schema, output, tags, privacy.
 *
 * [Source: get_skill_schema; lokyy-skill-creator skill; Story 10.2]
 */

/** Vault-Ordner, in dem Skills leben. */
export const SKILLS_FOLDER = "70_pai/skills";

/** Roh-Eingaben aus dem Dialog. */
export interface NewSkillInput {
  /** Anzeigetitel (Pflicht, nicht-leer). */
  title: string;
  /** Maschinenname (lowercase-kebab). Wird aus dem Titel abgeleitet, ist aber editierbar. */
  skillName: string;
  /** Einzeilige Beschreibung (Pflicht, nicht-leer). */
  description: string;
  /** Prompt-/Ausführungs-Body (Markdown). */
  body: string;
  /**
   * Optionale advisory Tool-Liste (`allowed_tools`). Schon als Array — der
   * Dialog splittet die Komma-Eingabe vor dem Aufruf.
   */
  allowedTools?: string[];
}

/** Ergebnis der Validierung — Feld → Fehlermeldung (leer = valide). */
export type SkillInputErrors = Partial<Record<"title" | "skillName" | "description", string>>;

/**
 * Slugify: Titel → `lowercase-kebab`, passend zum Schema-Pattern
 * `^[a-z0-9-]+$`. Diakritika werden via NFD entfernt, alles Nicht-
 * `[a-z0-9]` wird zu `-`, Mehrfach-/Rand-Bindestriche kollabieren.
 */
export function slugifySkillName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Diakritika abstreifen
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // alles andere → Bindestrich
    .replace(/^-+|-+$/g, "") // Rand-Bindestriche
    .replace(/-{2,}/g, "-"); // Mehrfach-Bindestriche kollabieren
}

/** Schema-Pattern für `skill_name`. */
const SKILL_NAME_RE = /^[a-z0-9-]+$/;

/**
 * Validiert die Eingaben gegen das Skill-Schema (Pflichtfelder + Pattern).
 * Liefert ein Fehler-Objekt; leeres Objekt = valide. Doppelter Name wird hier
 * NICHT geprüft (braucht den Vault-Stand) — das macht der Dialog gegen die
 * bekannte Skill-Liste bzw. der Server beim Schreiben.
 */
export function validateSkillInput(input: NewSkillInput): SkillInputErrors {
  const errors: SkillInputErrors = {};
  if (input.title.trim() === "") {
    errors.title = "Titel ist erforderlich.";
  }
  const name = input.skillName.trim();
  if (name === "") {
    errors.skillName = "Skill-Name ist erforderlich.";
  } else if (!SKILL_NAME_RE.test(name)) {
    errors.skillName = "Nur Kleinbuchstaben, Ziffern und Bindestriche (a-z, 0-9, -).";
  }
  if (input.description.trim() === "") {
    errors.description = "Beschreibung ist erforderlich.";
  }
  return errors;
}

/** Vault-Pfad (Note-id ohne `.md`) für einen Skill-Namen. */
export function skillPath(skillName: string): string {
  return `${SKILLS_FOLDER}/${skillName.trim()}`;
}

/**
 * YAML-Skalar sicher serialisieren. Wir quoten defensiv jeden String, der
 * kein simpler Bezeichner ist (Sonderzeichen, Doppelpunkt, führende/folgende
 * Spaces, YAML-Indikatoren). Einfacher, dependency-freier Ersatz für
 * gray-matter/js-yaml (beide node-only / nicht im Bundle).
 */
function yamlScalar(value: string): string {
  // Simpler Fall: kurzer Wert ohne YAML-kritische Zeichen → unquoted.
  if (/^[A-Za-z0-9][A-Za-z0-9 _.\-/]*$/.test(value) && value.trim() === value) {
    return value;
  }
  // Doppelte Quotes mit Escaping für `"` und `\`.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Standard-Body-Gerüst für einen neuen Skill — sinnvoll vorbefüllt, damit der
 * Nutzer nur noch anpassen muss. Nutzt den Titel als H1 und zeigt das
 * `{{token}}`-Muster (run_skill substituiert Tokens aus dem input_schema).
 */
export function defaultSkillBody(title: string): string {
  const t = title.trim() || "Neuer Skill";
  return [
    `# ${t}`,
    "",
    "Beschreibe hier Schritt für Schritt, was dieser Skill tun soll.",
    "",
    "Eingaben referenzierst du als Tokens, z. B. {{topic}} — `run_skill`",
    "ersetzt sie beim Aufruf aus dem `input_schema`.",
    "",
    "1. …",
    "2. …",
    "",
    "Verweise auf verwandte Notizen via [[Wikilinks]].",
    "",
  ].join("\n");
}

/**
 * Baut das vollständige Markdown (YAML-Frontmatter + Body) einer SPEC-validen
 * `type: skill`-Note aus den (als valide angenommenen) Eingaben.
 *
 * Erzeugte Felder: type, title, skill_name, description, execution: client,
 * optional allowed_tools (nur wenn nicht-leer). `id`/`created`/`updated`
 * fügt der Server beim Schreiben hinzu — siehe Datei-Header.
 *
 * Voraussetzung: `validateSkillInput(input)` ist leer. Der Aufrufer (Dialog)
 * stellt das sicher; hier wird nur noch getrimmt/serialisiert.
 */
export function buildSkillNoteMarkdown(input: NewSkillInput): string {
  const title = input.title.trim();
  const skillName = input.skillName.trim();
  const description = input.description.trim();
  const tools = (input.allowedTools ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const body = input.body.trim() === "" ? defaultSkillBody(title) : input.body;

  const lines: string[] = ["---"];
  lines.push("type: skill");
  lines.push(`title: ${yamlScalar(title)}`);
  lines.push(`skill_name: ${yamlScalar(skillName)}`);
  lines.push(`description: ${yamlScalar(description)}`);
  lines.push("execution: client");
  if (tools.length > 0) {
    lines.push("allowed_tools:");
    for (const tool of tools) lines.push(`  - ${yamlScalar(tool)}`);
  }
  lines.push("---");
  lines.push("");

  // Body ohne führende Leerzeilen anhängen; genau ein abschließendes \n.
  const bodyText = body.replace(/^\n+/, "").replace(/\n+$/, "");
  return `${lines.join("\n")}\n${bodyText}\n`;
}
