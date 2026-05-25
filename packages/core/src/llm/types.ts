export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ChatOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: ToolDef[];
  stream?: boolean;
  extra?: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  finishReason: "stop" | "length" | "tool_use" | "error";
}

export interface EmbedOpts {
  model?: string;
  dimensions?: number;
  inputType?: "search_document" | "search_query" | "classification";
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  usage: { inputTokens: number };
}

export interface RerankOpts {
  model?: string;
  topN?: number;
}

export interface RerankResult {
  rankings: Array<{ index: number; score: number }>;
  model: string;
  usage?: { inputTokens: number };
}

export interface ProviderCapabilities {
  chat: boolean;
  embed: boolean;
  rerank: boolean;
  stream: boolean;
  toolCalling: boolean;
}

export interface ProviderInfo {
  name: string; // "anthropic" | "openai" | "ollama" | "openai-compat" | "google" | "cohere" | "voyage"
  preset?: string; // for openai-compat: "openrouter" | "eurouter" | "cortex" | "groq" | "together" | "lm-studio" | "vllm" | "custom"
  baseUrl?: string;
  defaultModel?: string;
  capabilities: ProviderCapabilities;
  isLocal: boolean; // privacy-tier-relevant
}

export interface LlmProvider {
  info: ProviderInfo;
  chat?(messages: ChatMessage[], opts?: ChatOpts): Promise<ChatResult>;
  embeddings?(texts: string[], opts?: EmbedOpts): Promise<EmbedResult>;
  rerank?(query: string, documents: string[], opts?: RerankOpts): Promise<RerankResult>;
  testConnection(): Promise<TestConnectionResult>;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  modelsAvailable?: string[];
}

export type LlmRole =
  | "embedding"
  | "rerank"
  | "topic-synthesis"
  | "query-rewrite"
  | "hyde"
  | "self-rag"
  | "lint"
  | "ner"
  | "mem0-classifier"
  | "intent-classifier";

export type PrivacyTier = "always_local" | "local_for_personal_folders" | "cloud_ok";

export interface ProviderConfig {
  name: string;
  preset?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  enabled: boolean;
  monthlyBudgetUsd?: number;
}

export interface LlmRoutingConfig {
  /** maps each role to a provider name (the provider config name in providers[]) */
  roles: Partial<Record<LlmRole, { provider: string; model?: string }>>;
  /** fallback chain per role */
  fallbacks?: Partial<Record<LlmRole, string[]>>;
  privacyTier: PrivacyTier;
  privacyTierFolders?: string[]; // for local_for_personal_folders
}

export interface UsageEvent {
  provider: string;
  role: LlmRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  timestamp: Date;
}

export interface UsageStats {
  provider: string;
  monthInputTokens: number;
  monthOutputTokens: number;
  monthCostUsd: number;
  budgetUsd?: number;
  budgetPercent?: number;
}
