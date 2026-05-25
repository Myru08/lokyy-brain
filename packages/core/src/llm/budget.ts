import type { UsageEvent, UsageStats } from "./types.js";

/**
 * Tracks LLM usage + cost per provider per month.
 * Storage: persisted to system_config or a dedicated table (this implementation
 * uses an in-memory + sql-backed approach; the SQL persistence is filed as a
 * follow-up so Wave A can ship without DB migration).
 */
export class BudgetTracker {
  private events: UsageEvent[] = [];

  async record(event: UsageEvent): Promise<void> {
    this.events.push(event);
  }

  async monthlyUsage(provider: string, now: Date = new Date()): Promise<UsageStats> {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const relevant = this.events.filter(
      (e) => e.provider === provider && e.timestamp >= monthStart,
    );
    const input = relevant.reduce((s, e) => s + e.inputTokens, 0);
    const output = relevant.reduce((s, e) => s + e.outputTokens, 0);
    const cost = relevant.reduce((s, e) => s + e.estimatedCostUsd, 0);
    return {
      provider,
      monthInputTokens: input,
      monthOutputTokens: output,
      monthCostUsd: cost,
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

  /** Estimate cost based on token counts. Provider-specific pricing tables. */
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
}

// Singleton
let _budget: BudgetTracker | null = null;

export function budgetTracker(): BudgetTracker {
  if (!_budget) _budget = new BudgetTracker();
  return _budget;
}
