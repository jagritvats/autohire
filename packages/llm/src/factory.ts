import { nonEmpty, type LlmProvider, type ProviderConfig } from "./provider.js";
import { EchoProvider } from "./providers/echo.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

/**
 * Build the configured provider. Explicit config wins over env, but only when it is
 * actually set: `undefined` and "" never override (a blank settings field or a
 * docker-compose `${VAR:-}` must not turn the model id into "").
 */
export function createProvider(cfg: ProviderConfig = {}): LlmProvider {
  const provider = (nonEmpty(cfg.provider) ?? nonEmpty(process.env.LLM_PROVIDER) ?? "echo").toLowerCase();
  const merged: ProviderConfig = {
    provider,
    cheapModel: nonEmpty(cfg.cheapModel) ?? nonEmpty(process.env.LLM_MODEL_CHEAP),
    strongModel: nonEmpty(cfg.strongModel) ?? nonEmpty(process.env.LLM_MODEL_STRONG),
    apiKey: nonEmpty(cfg.apiKey),
    baseUrl: nonEmpty(cfg.baseUrl),
    useEnvKey: cfg.useEnvKey ?? true,
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

/** The per-tenant LLM settings (TenantConfig's llm* fields). */
export interface TenantLlmConfig {
  llmChoice?: string | null;
  llmModel?: string | null;
  llmApiKey?: string | null;
  llmBaseUrl?: string | null;
}

/**
 * The provider a tenant's generation runs on (per-user capability):
 *   1. the tenant's own key (or own base URL, for a keyless local gateway) → their
 *      provider/model/base URL, and NEVER the operator's env key;
 *   2. otherwise the operator's env provider + key, only when `operatorFallback` is on
 *      (JOBFLOW_OPERATOR_LLM=shared). The tenant may pick the model but not the base
 *      URL — the operator's key must never be sent to a tenant-chosen host;
 *   3. otherwise the offline echo provider (generators then use deterministic builders
 *      or refuse — echo is never passed off as a draft, invariant #3).
 */
export function providerForTenant(
  config: TenantLlmConfig | null | undefined,
  opts: { operatorFallback: boolean },
): LlmProvider {
  const choice = nonEmpty(config?.llmChoice)?.toLowerCase();
  if (choice === "echo") return new EchoProvider();
  const key = nonEmpty(config?.llmApiKey);
  const baseUrl = nonEmpty(config?.llmBaseUrl);
  const model = nonEmpty(config?.llmModel);

  if (choice && (key || baseUrl)) {
    return createProvider({ provider: choice, apiKey: key, baseUrl, strongModel: model, useEnvKey: false });
  }
  if (opts.operatorFallback) {
    // the operator's own provider; a tenant choice of a different provider has no
    // operator key behind it, so it can't be honoured here
    const envProvider = nonEmpty(process.env.LLM_PROVIDER)?.toLowerCase();
    if (!envProvider || envProvider === "echo" || (choice && choice !== envProvider)) return new EchoProvider();
    return createProvider({ provider: envProvider, strongModel: model, useEnvKey: true });
  }
  return new EchoProvider();
}
