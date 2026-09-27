import type { ChannelMessage } from "@jobflow/core";
import { htmlToText } from "../types.js";

/**
 * Public Telegram channels (Tier 1-2: public, no login). Every public channel has a
 * static web preview at `/s/{channel}` — ~20 newest posts with text, links and an
 * ISO timestamp; `?before={id}` pages back. We read it as DISCOVERY only: the pipeline
 * pulls ATS / careers links out of each post and polls the company's board for the
 * real posting (channels repost stale roles, strip dates, and carry scams).
 *
 * telegram.me is tried first: t.me is TLS-reset on some Indian ISPs while the
 * identical telegram.me host is reachable.
 */
const HOSTS = ["https://telegram.me", "https://t.me"];

export interface TelegramFetchOptions {
  /** preview pages to walk back (≈20 posts each). */
  pages?: number;
  timeoutMs?: number;
}

export async function fetchTelegramChannel(channel: string, opts: TelegramFetchOptions = {}): Promise<ChannelMessage[]> {
  const name = channel.replace(/^@|^https?:\/\/(t|telegram)\.me\/(s\/)?/i, "").split(/[/?#]/)[0];
  if (!name) return [];
  const pages = Math.max(1, opts.pages ?? 2);
  const out: ChannelMessage[] = [];
  let before: number | null = null;
  for (let i = 0; i < pages; i++) {
    const path = `/s/${encodeURIComponent(name)}${before ? `?before=${before}` : ""}`;
    const html = await fetchFirst(path, opts.timeoutMs ?? 15_000);
    if (!html) break;
    const msgs = parseTelegramPreview(html);
    if (!msgs.length) break;
    out.push(...msgs);
    const ids = msgs.map((m) => Number(m.ref?.split("/")[1])).filter(Number.isFinite);
    const min = Math.min(...ids);
    if (!Number.isFinite(min) || min <= 1 || min === before) break;
    before = min;
  }
  return out;
}

async function fetchFirst(path: string, timeoutMs: number): Promise<string | null> {
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${host}${path}`, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; JobFlow/0.1; +personal job-search)", Accept: "text/html" },
      });
      if (res.ok) return await res.text();
    } catch {
      // try the next host
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Parse a `/s/{channel}` preview page. Links are appended to the text so the link
 *  harvester sees hrefs whose anchor text was a label ("Apply here"). */
export function parseTelegramPreview(html: string): ChannelMessage[] {
  const chunks = html.split(/class="tgme_widget_message_wrap/).slice(1);
  const out: ChannelMessage[] = [];
  for (const chunk of chunks) {
    const ref = chunk.match(/data-post="([^"]+)"/)?.[1];
    const datetime = chunk.match(/<time datetime="([^"]+)"/)?.[1];
    const start = chunk.indexOf("tgme_widget_message_text");
    if (start < 0) continue;
    const endCandidates = ["tgme_widget_message_footer", "tgme_widget_message_info", "tgme_widget_message_reactions"]
      .map((c) => chunk.indexOf(c, start))
      .filter((i) => i > start);
    const segment = chunk.slice(chunk.indexOf(">", start) + 1, endCandidates.length ? Math.min(...endCandidates) : undefined);
    const hrefs = [...chunk.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    const text = [htmlToText(segment), ...new Set(hrefs)].join("\n").trim();
    if (!text) continue;
    const postedAt = datetime ? new Date(datetime) : null;
    out.push({ text, postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null, ref });
  }
  return out;
}
