-- LLM/generation provider config (§ Customize, vision §6.1 — tenant_config holds the
-- LLM choice). Makes generation selectable from /settings: provider + model override +
-- API key (blank → env fallback) + custom base URL. Single-user/local: the key lives
-- in tenant_config; multi-tenant deployments should move secrets to a vault.

alter table tenant_config
  add column if not exists llm_model    text not null default '',
  add column if not exists llm_api_key  text not null default '',
  add column if not exists llm_base_url text not null default '';
