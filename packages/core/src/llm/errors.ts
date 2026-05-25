export class LlmError extends Error {
  constructor(public code: string, message: string, public providerName?: string) {
    super(message);
    this.name = "LlmError";
  }
}

export class LlmRateLimited extends LlmError {
  constructor(providerName: string, message = "rate limited") {
    super("RATE_LIMITED", message, providerName);
    this.name = "LlmRateLimited";
  }
}

export class LlmAuthError extends LlmError {
  constructor(providerName: string, message = "authentication failed") {
    super("AUTH_ERROR", message, providerName);
    this.name = "LlmAuthError";
  }
}

export class LlmUnavailable extends LlmError {
  constructor(providerName: string, message = "provider unavailable") {
    super("UNAVAILABLE", message, providerName);
    this.name = "LlmUnavailable";
  }
}

export class LlmBudgetExceeded extends LlmError {
  constructor(providerName: string, budget: number) {
    super(
      "BUDGET_EXCEEDED",
      `monthly budget $${budget} exceeded for ${providerName}`,
      providerName,
    );
    this.name = "LlmBudgetExceeded";
  }
}

export class LlmCapabilityMissing extends LlmError {
  constructor(providerName: string, capability: string) {
    super(
      "CAPABILITY_MISSING",
      `${providerName} does not support ${capability}`,
      providerName,
    );
    this.name = "LlmCapabilityMissing";
  }
}
