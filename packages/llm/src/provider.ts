/**
 * One LLM interface, swappable per task (§6, §12 Q2). The cheap model handles
 * normalize/titles; the strong model handles re-rank/answers. Providers:
 *   - echo     : offline deterministic stub (no network) — default for dev/tests
 *   - anthropic: Claude (Messages API)
 *   - grok     : xAI (OpenAI-compatible)
 *   - openai   : OpenAI
 */

export type LlmTask = "cheap" | "strong";

export interface CompletionRequest {
  system?: string;
  prompt: string;
  task?: LlmTask;
  maxTokens?: number;
  temperature?: number;
  /** ask the provider for strict JSON; the caller still validates with Zod */
  json?: boolean;
  /** per-call network timeout (ms); provider aborts + throws a typed timeout on expiry. */
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ProviderConfig {
  provider?: string;
  cheapModel?: string;
  strongModel?: string;
  apiKey?: string;
  baseUrl?: string;
}
