/**
 * Résumé date ranges: "Jan 2023 – Present", "01/2021 - 12/2022", "2019–2021",
 * "2021-03 to 2022-11", "Since"-less. Output dates are "YYYY-MM" (month known) or "YYYY"
 * (year only) — the precision the source actually gave, never more.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAME = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const YEAR = String.raw`(?:19[5-9]\d|20\d{2})`;
const DATE = String.raw`(?:${MONTH_NAME}\s*,?\s*'?${YEAR}|(?:0?[1-9]|1[0-2])\s*[/.]\s*${YEAR}|${YEAR}\s*[-/.]\s*(?:0[1-9]|1[0-2])(?![\d])|${YEAR})`;
const PRESENT = String.raw`(?:present|current(?:ly)?|now|today|ongoing|till date|to date|date)`;
const SEP = String.raw`\s*(?:-{1,3}|–|—|~|to|until|till|through|thru)\s*`;

/** A whole date range anywhere in a line. Group 1 = start, group 2 = end. */
export const DATE_RANGE_RE = new RegExp(String.raw`(?<![\w/])(${DATE})${SEP}(${DATE}|${PRESENT})(?![\w/])`, "i");

export interface DateRange {
  start: string;
  end: string | null;
  current: boolean;
  /** the matched text, verbatim */
  raw: string;
  index: number;
}

/** Parse one date token → "YYYY-MM" / "YYYY", or null. */
export function parseDateToken(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/[.,']/g, " ").replace(/\s+/g, " ");
  let m = /^([a-z]+) ?((?:19|20)\d{2})$/.exec(t);
  if (m) {
    const mon = MONTHS[m[1]!.slice(0, 3)];
    return mon ? `${m[2]}-${String(mon).padStart(2, "0")}` : null;
  }
  m = /^(\d{1,2}) ?\/ ?((?:19|20)\d{2})$/.exec(t) ?? /^(\d{1,2}) ((?:19|20)\d{2})$/.exec(t);
  if (m) {
    const mon = Number(m[1]);
    return mon >= 1 && mon <= 12 ? `${m[2]}-${String(mon).padStart(2, "0")}` : null;
  }
  m = /^((?:19|20)\d{2}) ?[-/ ] ?(\d{2})$/.exec(t);
  if (m) {
    const mon = Number(m[2]);
    return mon >= 1 && mon <= 12 ? `${m[1]}-${m[2]}` : null;
  }
  m = /^((?:19|20)\d{2})$/.exec(t);
  return m ? m[1]! : null;
}

/** Find the first date range in a line. */
export function findDateRange(line: string): DateRange | null {
  const m = DATE_RANGE_RE.exec(line);
  if (!m) return null;
  const start = parseDateToken(m[1]!);
  if (!start) return null;
  const endRaw = m[2]!;
  const current = new RegExp(`^${PRESENT}$`, "i").test(endRaw.trim());
  const end = current ? null : parseDateToken(endRaw);
  if (!current && !end) return null;
  if (end && monthIndex(end, "end") < monthIndex(start, "start")) return null;
  return { start, end, current, raw: m[0], index: m.index };
}

/**
 * A date as a month index (year*12 + month-1). Year-only dates sit mid-year, so
 * "2019–2021" reads as two years, not three.
 */
export function monthIndex(d: string, _edge: "start" | "end"): number {
  const [y, mo] = d.split("-");
  const year = Number(y);
  const month = mo ? Number(mo) : 6;
  return year * 12 + (month - 1);
}

export function nowMonthIndex(now: Date): number {
  return now.getUTCFullYear() * 12 + now.getUTCMonth();
}
