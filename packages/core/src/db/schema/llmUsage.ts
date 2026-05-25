import { pgTable, text, timestamp, integer, doublePrecision, index } from "drizzle-orm/pg-core";

/**
 * Per-event LLM usage ledger. Append-only.
 *
 * Phase-0 Wave D / Agent 2: replaces the previous in-memory event buffer in
 * `BudgetTracker` so usage history survives server restart. Aggregations
 * (`monthlyUsage`, `listMonthlyUsage`) run as `SUM(...)` queries against
 * this table — there is no precomputed monthly rollup.
 *
 * Indexes:
 *   - (provider, timestamp) → fast `monthlyUsage(provider, since)` scans
 *   - (timestamp)           → fast `listMonthlyUsage(since)` cross-provider
 */
export const llmUsageEvents = pgTable(
  "llm_usage_events",
  {
    id: text("id").primaryKey(), // ULID
    provider: text("provider").notNull(),
    role: text("role").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    estimatedCostUsd: doublePrecision("estimated_cost_usd").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (table) => ({
    providerTsIdx: index("idx_llm_usage_provider_ts").on(table.provider, table.timestamp),
    tsIdx: index("idx_llm_usage_ts").on(table.timestamp),
  }),
);

export type LlmUsageEvent = typeof llmUsageEvents.$inferSelect;
export type NewLlmUsageEvent = typeof llmUsageEvents.$inferInsert;
