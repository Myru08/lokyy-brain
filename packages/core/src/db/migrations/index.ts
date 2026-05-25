/**
 * Migration registry. Each entry is an `{ name, sql }` pair, applied
 * in order. Adding a new migration: append to this array — never remove
 * or reorder, the names are tracked in `_lokyy_migrations`.
 */

import { migration0000Initial } from "./0000_initial.js";

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { name: "0000_initial", sql: migration0000Initial },
];
