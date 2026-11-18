/**
 * Each provider's default models — the one place they're named. The factory/providers use
 * them when no model is configured, and the web Settings page shows them as placeholders
 * (imported via `@jobflow/llm/models`, which is dependency-free so a client bundle can take
 * it), so the hint can't drift from what actually runs.
 */
export const ANTHROPIC_DEFAULT_CHEAP = "claude-haiku-5-5";
export const ANTHROPIC_DEFAULT_STRONG = "claude-opus-5-5";
export const OPENAI_DEFAULT_CHEAP = "gpt-5-mini";
export const OPENAI_DEFAULT_STRONG = "gpt-5";
export const GROK_DEFAULT_CHEAP = "grok-3-mini";
export const GROK_DEFAULT_STRONG = "grok-4";

/** strong = re-rank, tailoring, answers (what a tenant's "model" setting replaces); cheap = extraction */
export const DEFAULT_MODELS = {
  anthropic: { strong: ANTHROPIC_DEFAULT_STRONG, cheap: ANTHROPIC_DEFAULT_CHEAP },
  openai: { strong: OPENAI_DEFAULT_STRONG, cheap: OPENAI_DEFAULT_CHEAP },
  grok: { strong: GROK_DEFAULT_STRONG, cheap: GROK_DEFAULT_CHEAP },
} as const satisfies Record<string, { strong: string; cheap: string }>;
