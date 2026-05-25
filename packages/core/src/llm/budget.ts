import { and, eq, gte, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { database } from "../db/index.js";
import { llmUsageEvents } from "../db/schema/llmUsage.js";
import type { UsageEvent, UsageStats } from "./types.js";

/**
 * Tracks LLM usage + cost per provider per month.
 *
 * Storage: Postgres table `llm_usage_events` (append-only ledger). Aggregations
 * run as `SUM(...)` queries; there is no precomputed monthly rollup. Indexes
 * `(provider, timestamp)` and `(timestamp)` cover the two read paths used here
 * (`monthlyUsage`, `listMonthlyUsage`).
 *
 * Pricing data lives inside `estimateCost` — the canonical 2026 price table.
 */
export class BudgetTracker {
  async record(event: UsageEvent): Promise<void> {
    const db = database();
    await db.insert(llmUsageEvents).values({
      id: ulid(),
      provider: event.provider,
      role: event.role,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      estimatedCostUsd: event.estimatedCostUsd,
      timestamp: event.timestamp,
    });
  }

  async monthlyUsage(provider: string, now: Date = new Date()): Promise<UsageStats> {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const db = database();
    const rows = await db
      .select({
        monthInputTokens: sql<number>`COALESCE(SUM(${llmUsageEvents.inputTokens}), 0)::int`,
        monthOutputTokens: sql<number>`COALESCE(SUM(${llmUsageEvents.outputTokens}), 0)::int`,
        monthCostUsd: sql<number>`COALESCE(SUM(${llmUsageEvents.estimatedCostUsd}), 0)::float8`,
      })
      .from(llmUsageEvents)
      .where(
        and(eq(llmUsageEvents.provider, provider), gte(llmUsageEvents.timestamp, monthStart)),
      );
    const r = rows[0] ?? {
      monthInputTokens: 0,
      monthOutputTokens: 0,
      monthCostUsd: 0,
    };
    return {
      provider,
      monthInputTokens: Number(r.monthInputTokens) || 0,
      monthOutputTokens: Number(r.monthOutputTokens) || 0,
      monthCostUsd: Number(r.monthCostUsd) || 0,
    };
  }

  async checkBudget(
    provider: string,
    budgetUsd: number,
    now: Date = new Date(),
  ): Promise<{ remainingUsd: number; capReached: boolean; budgetPercent: number }> {
    const usage = await this.monthlyUsage(provider, now);
    const remainingUsd = Math.max(0, budgetUsd - usage.monthCostUsd);
    return {
      remainingUsd,
      capReached: usage.monthCostUsd >= budgetUsd,
      budgetPercent: budgetUsd > 0 ? (usage.monthCostUsd / budgetUsd) * 100 : 0,
    };
  }

  /** Estimate cost based on token counts. Provider-specific pricing tables (2026). */
  estimateCost(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    // Pricing per 1M tokens (USD), 2026 prices
    const pricing: Record<string, Record<string, { in: number; out: number }>> = {
      anthropic: {
        "claude-haiku-4-5": { in: 0.25, out: 1.25 },
        "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
        "claude-opus-4-7": { in: 15.0, out: 75.0 },
      },
      openai: {
        "gpt-4o-mini": { in: 0.15, out: 0.6 },
        "gpt-4o": { in: 2.5, out: 10.0 },
        "text-embedding-3-small": { in: 0.02, out: 0 },
        "text-embedding-3-large": { in: 0.13, out: 0 },
      },
      google: {
        "gemini-2.5-flash": { in: 0.075, out: 0.3 },
        "gemini-2.5-pro": { in: 1.25, out: 10.0 },
      },
      ollama: {}, // local = $0
    };
    const row = pricing[provider]?.[model];
    if (!row) return 0;
    return (inputTokens / 1_000_000) * row.in + (outputTokens / 1_000_000) * row.out;
  }

  /**
   * Aggregated monthly usage across all providers that have any event in the
   * current calendar month. Returned shape feeds the `/api/llm/config`
   * response `usage` field.
   */
  async listMonthlyUsage(now: Date = new Date()): Promise<UsageStats[]> {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const db = database();
    const rows = await db
      .select({
        provider: llmUsageEvents.provider,
        monthInputTokens: sql<number>`COALESCE(SUM(${llmUsageEvents.inputTokens}), 0)::int`,
        monthOutputTokens: sql<number>`COALESCE(SUM(${llmUsageEvents.outputTokens}), 0)::int`,
        monthCostUsd: sql<number>`COALESCE(SUM(${llmUsageEvents.estimatedCostUsd}), 0)::float8`,
      })
      .from(llmUsageEvents)
      .where(gte(llmUsageEvents.timestamp, monthStart))
      .groupBy(llmUsageEvents.provider);
    return rows.map((r) => ({
      provider: r.provider,
      monthInputTokens: Number(r.monthInputTokens) || 0,
      monthOutputTokens: Number(r.monthOutputTokens) || 0,
      monthCostUsd: Number(r.monthCostUsd) || 0,
    }));
  }
}

// Singleton
let _budget: BudgetTracker | null = null;

export function budgetTracker(): BudgetTracker {
  if (!_budget) _budget = new BudgetTracker();
  return _budget;
}
