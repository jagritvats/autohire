import "server-only";

/** In-process token bucket for login/signup. Per instance only — put a proxy limit in front at scale. */
const buckets = new Map<string, { tokens: number; at: number }>();

export function rateLimited(key: string, perMinute = 10): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (buckets.size > 10_000) buckets.clear();
  if (b.tokens < 1) {
    buckets.set(key, b);
    return true;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return false;
}

export function clientKey(req: Request): string {
  const fwd = process.env.JOBFLOW_TRUST_PROXY === "1" ? req.headers.get("x-forwarded-for")?.split(",")[0] : null;
  return (fwd ?? "direct").trim();
}
