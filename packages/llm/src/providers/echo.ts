import { localEmbed } from "@jobflow/core";
import type { CompletionRequest, LlmProvider } from "../provider.js";

/**
 * Offline stub provider — no network, deterministic. Lets the whole platform run
 * (re-rank, generation, prep) with zero API keys for dev/CI. For JSON tasks it
 * emits a minimal valid object so downstream Zod parsing succeeds.
 */
export class EchoProvider implements LlmProvider {
  readonly name = "echo";

  async complete(req: CompletionRequest): Promise<string> {
    if (req.json) {
      // Best-effort: detect the shape the caller expects from cues in the prompt.
      if (/whyFit|why this fits|red ?flags/i.test(req.prompt)) {
        return JSON.stringify({
          whyFit:
            "[echo] Strong overlap on backend/distributed-systems core; language gap is transferable.",
          gap: "[echo] Verify depth on the role's primary language and domain specifics.",
          redFlags: [],
        });
      }
      return "{}";
    }
    return `[echo:${req.task ?? "strong"}] ${req.prompt.slice(0, 280)}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => localEmbed(t));
  }
}
