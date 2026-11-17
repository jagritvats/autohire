// The single-user tenant id (JOBFLOW_AUTH=none). Only bootstrap code may use it — request
// handlers always use the caller's auth.tenantId (scripts/check-tenant.mjs enforces this).
export { DEFAULT_TENANT as DEFAULT_TENANT_ID } from "@jobflow/pipeline";
