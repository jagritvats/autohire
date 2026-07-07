import { NextResponse } from "next/server";
import { z } from "zod";
import { createProvider } from "@jobflow/llm";

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
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  const { provider, model, apiKey, baseUrl } = parsed.data;

  const llm = createProvider({
    provider: provider === "echo" ? "echo" : provider,
    strongModel: model || undefined,
    apiKey: apiKey || undefined,
    baseUrl: baseUrl || undefined,
  });

  const started = Date.now();
  try {
    const sample = await withTimeout(
      llm.complete({ prompt: "Reply with the single word: ok", maxTokens: 5, task: "strong", temperature: 0 }),
      15_000,
    );
    return NextResponse.json({ ok: true, name: llm.name, ms: Date.now() - started, sample: sample.trim().slice(0, 120) });
  } catch (e) {
    return NextResponse.json({ ok: false, name: llm.name, error: (e as Error).message });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)),
  ]);
}
