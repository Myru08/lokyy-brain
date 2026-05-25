import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * Key/value system configuration persisted in the database.
 *
 * Used by:
 *   - Story 1.10 setup-mode flag (`setup_complete` bool).
 *   - Story 1.12 vault URL change (`vault_url`, `vault_branch`).
 *   - Story 8.1 consolidation schedule (`consolidation_schedule`).
 */
export const systemConfig = pgTable("system_config", {
  key: text("key").primaryKey(),
  valueText: text("value_text"),
  valueBool: boolean("value_bool"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SystemConfig = typeof systemConfig.$inferSelect;
export type NewSystemConfig = typeof systemConfig.$inferInsert;
