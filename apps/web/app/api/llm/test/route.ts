import { NextResponse } from "next/server";
import { z } from "zod";
import { createProvider } from "@jobflow/llm";
import { getRepo } from "@/lib/repo";
import { authMode } from "@/lib/auth";
import { guard } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  provider: z.string().default("echo"),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

/**
 * Probe the configured generation provider with a 1-token round trip. Tests the
 * *unsaved* form values so a wrong key/model is caught in settings, not at generate
 * time. Only ever calls the provider the user chose with their own key.
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  const { provider, model, baseUrl } = parsed.data;
  // blank key field = test the SAVED key (the form never receives it back)
  const saved = parsed.data.apiKey ? null : await (await getRepo()).getConfig(auth.tenantId);
  const apiKey = parsed.data.apiKey || saved?.llmApiKey || undefined;
  if (authMode() === "password") {
    // on a shared server, never fall back to the operator's env key, and never call an
    // arbitrary internal URL on a user's behalf (SSRF)
    if (provider !== "echo" && !apiKey && process.env.JOBFLOW_OPERATOR_LLM !== "shared") {
      return NextResponse.json({ ok: false, error: "Add your own API key for this provider." }, { status: 400 });
    }
    if (baseUrl && !(await publicHttpsUrl(baseUrl))) {
      return NextResponse.json({ ok: false, error: "The base URL must be a public https:// address." }, { status: 400 });
    }
  }

  const llm = createProvider({
    provider: provider === "echo" ? "echo" : provider,
    strongModel: model || undefined,
    apiKey: apiKey || undefined,
    baseUrl: baseUrl || undefined,
  });

  const started = Date.now();
  try {
    const sample = await withTimeout(
      llm.complete({ prompt: "Reply with the single word: ok", maxTokens: 16, task: "strong" }),
      15_000,
    );
    return NextResponse.json({ ok: true, name: llm.name, ms: Date.now() - started, sample: sample.trim().slice(0, 120) });
  } catch (e) {
    return NextResponse.json({ ok: false, name: llm.name, error: (e as Error).message });
  }
}

async function publicHttpsUrl(url: string): Promise<boolean> {
  try {
    const { safeUrl } = await import("@jobflow/adapters");
    await safeUrl(url);
    return url.startsWith("https://");
  } catch {
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)),
  ]);
}
