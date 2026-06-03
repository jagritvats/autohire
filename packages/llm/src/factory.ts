import type { LlmProvider, ProviderConfig } from "./provider.js";
import { EchoProvider } from "./providers/echo.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

/** Build the configured provider. Reads env when not passed explicitly. */
export function createProvider(cfg: ProviderConfig = {}): LlmProvider {
  const provider = (cfg.provider ?? process.env.LLM_PROVIDER ?? "echo").toLowerCase();
  const merged: ProviderConfig = {
    cheapModel: cfg.cheapModel ?? process.env.LLM_MODEL_CHEAP,
    strongModel: cfg.strongModel ?? process.env.LLM_MODEL_STRONG,
    ...cfg,
  };
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(merged);
    case "grok":
      return new OpenAICompatibleProvider("grok", merged);
    case "openai":
      return new OpenAICompatibleProvider("openai", merged);
    case "echo":
    default:
      return new EchoProvider();
  }
}
