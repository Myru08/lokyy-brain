import type { DocType } from "../frontmatter/types.js";

/**
 * Thrown by `createNote` when a caller supplies a full `path` whose folder
 * contradicts the note's declared `type` (Story 10.2, AC#5).
 *
 * Distinct from generic Error / FrontmatterValidationError so the MCP tool
 * handler (and REST route) can surface the exact structured correction
 * payload `{ error: "type-folder-mismatch", type, expectedFolder, gotPath }`
 * instead of a generic failure.
 */
export class TypeFolderMismatchError extends Error {
  readonly type: DocType;
  readonly expectedFolder: string;
  readonly gotPath: string;

  constructor(opts: { type: DocType; expectedFolder: string; gotPath: string }) {
    super(
      `Note type "${opts.type}" belongs under "${opts.expectedFolder}/" but path was "${opts.gotPath}".`,
    );
    this.name = "TypeFolderMismatchError";
    this.type = opts.type;
    this.expectedFolder = opts.expectedFolder;
    this.gotPath = opts.gotPath;
  }
}
