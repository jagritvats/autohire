-- Tenant scoping for the multi-user product (docs/internal/PRODUCT_PLAN.md).
--  * agent_heartbeat.token_id — which API token the local agent authenticated with, so a
--    revoked token's agent shows as such.
--  * tenant_config.llm_api_key_enc — the tenant's LLM key AES-256-GCM-encrypted with
--    JOBFLOW_SECRET_KEY (`v1:iv:tag:ct`); when set, llm_api_key is left blank. Rows written
--    without a secret key keep the plaintext column (legacy / single-user).
--  * posting.contributed_by — the tenant whose custom source/search first found a posting.
--    Postings stay a shared, global corpus; this is attribution, not ownership.
--  * job index for the tenant-filtered claim (a local agent drains only its own tenant).
-- Idempotent: safe to re-run.

alter table agent_heartbeat add column if not exists token_id text;

alter table tenant_config add column if not exists llm_api_key_enc text;

alter table posting
  add column if not exists contributed_by uuid references tenant(id) on delete set null;

create index if not exists job_runtime_tenant_idx on job (runtime, tenant_id, status, created_at);
