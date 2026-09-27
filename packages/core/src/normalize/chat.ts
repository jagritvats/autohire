/**
 * Chat-export parsing for community job channels. WhatsApp has no read API and
 * automating WhatsApp Web risks the user's account, so the supported path is the
 * app's own "Export chat" (.txt) — user-provided data, parsed offline, no automation.
 */

/**
 * Zero-width space / non-joiner / joiner, LRM / RLM (WhatsApp prefixes lines with an
 * LRM), word joiner and BOM. Built from code points so the source stays readable.
 */
const INVISIBLE = new RegExp(
  `[${[0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff].map((c) => String.fromCharCode(c)).join("")}]`,
  "g",
);

/**
 * Channel text is decorated: "mathematical bold" Unicode letters for emphasis and
 * invisible characters inside words (a BOM in the middle of "Experience"). Fold both
 * before any regex, or scam phrases and URLs slip through unmatched.
 */
export function normalizeChatText(text: string): string {
  return (text ?? "").normalize("NFKC").replace(INVISIBLE, "");
}

export interface ChannelMessage {
  text: string;
  /** when the message was posted — used to skip stale forwards. */
  postedAt: Date | null;
  /** stable reference (channel/post id, or export line) for provenance. */
  ref?: string;
}

// Android: "26/09/2026, 10:15 - Name: text"   (optionally "10:15 am")
// iOS:     "[26/09/26, 10:15:30] Name: text"   (optionally "10:15:30 AM")
const HEADER =
  /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\]?\s*(?:-\s*)?([^:]{1,60}?):\s?(.*)$/i;

/**
 * Parse a WhatsApp "Export chat" text file into messages. Dates are read day-first
 * (the Indian locale default) unless the first field can only be a month (>12 in the
 * second slot). System lines ("Messages are end-to-end encrypted") have no sender and
 * are skipped; continuation lines are folded into the previous message.
 */
export function parseWhatsAppExport(text: string): ChannelMessage[] {
  const out: ChannelMessage[] = [];
  let cur: ChannelMessage | null = null;
  const lines = (text ?? "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = normalizeChatText(raw);
    const m = line.match(HEADER);
    if (m) {
      if (cur) out.push(cur);
      cur = { text: m[9] ?? "", postedAt: headerDate(m), ref: `line:${i + 1}` };
    } else if (cur && line.trim()) {
      cur.text += `\n${line}`;
    }
  });
  if (cur) out.push(cur);
  return out.filter((msg) => msg.text.trim() && !/^<media omitted>$|^this message was deleted$/i.test(msg.text.trim()));
}

function headerDate(m: RegExpMatchArray): Date | null {
  let a = Number(m[1]);
  let b = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  // day-first unless impossible (e.g. "09/26/2026" → month-first)
  let day = a;
  let month = b;
  if (b > 12 && a <= 12) {
    day = b;
    month = a;
  }
  let hour = Number(m[4]);
  const ampm = m[7]?.toLowerCase().replace(/\./g, "");
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const d = new Date(y, month - 1, day, hour, Number(m[5]), Number(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}
