import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { fetchTelegramChannel } from "@jobflow/adapters";
import { parseWhatsAppExport } from "@jobflow/core";
import { harvestLinks } from "@jobflow/pipeline";
import type { Ctx } from "../context.js";
import { usage } from "../errors.js";
import { demo } from "../legacy/demo.js";
import { csv } from "./shared.js";

export function register(program: Command, ctx: Ctx): void {
  program
    .command("demo")
    .description("a bounded live run of the whole pipeline with the FICTIONAL sample persona (in-memory; your data is untouched)")
    .action(async () => {
      await demo();
    });

  program
    .command("harvest")
    .description("pull ATS/careers links from Telegram channels or a WhatsApp export and register those boards")
    .option("--telegram <channels>", "public channel names, comma-separated")
    .option("--whatsapp <export.txt>", "a WhatsApp chat export")
    .option("--max-age-days <n>", "ignore messages older than this", "30")
    .action(async (o: { telegram?: string; whatsapp?: string; maxAgeDays: string }) => {
      if (!o.telegram && !o.whatsapp) throw usage("give --telegram <chan,chan> and/or --whatsapp <export.txt>");
      const repo = await ctx.repo();
      const maxAgeDays = Number(o.maxAgeDays) || 30;
      const results: Array<{ origin: string; messages: number; boards: string[] }> = [];
      for (const channel of csv(o.telegram)) {
        const msgs = await fetchTelegramChannel(channel, { pages: 3 });
        const s = await harvestLinks(repo, msgs, { origin: `telegram:${channel}`, maxAgeDays });
        results.push({ origin: `telegram/${channel}`, messages: s.messages, boards: s.boards });
      }
      if (o.whatsapp) {
        const msgs = parseWhatsAppExport(await readFile(ctx.userPath(o.whatsapp), "utf8"));
        const s = await harvestLinks(repo, msgs, { origin: "whatsapp:export", maxAgeDays });
        results.push({ origin: "whatsapp", messages: s.messages, boards: s.boards });
      }
      ctx.out.emit(results, () => {
        for (const r of results) {
          ctx.out.line(`${r.origin}: ${r.messages} messages, ${r.boards.length} board(s)`);
          for (const b of r.boards) ctx.out.line(`   + ${b}`);
        }
        ctx.out.hint("Registered boards are polled on the next `jobflow sync`.");
      });
    });
}
