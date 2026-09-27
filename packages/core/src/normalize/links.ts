/**
 * Link-first harvesting for community channels (Telegram / WhatsApp / pasted lists).
 * Messages there are unstructured, often stale, and sometimes scams — so we never trust
 * the message as the posting. We pull the URLs out, and the ones that point at a
 * company's ATS become DISCOVERY: the detector resolves the board, and the poll loop
 * fetches the real, fresh posting from the source of truth (§ discovery routing).
 */

export type LinkKind =
  /** a company ATS board or job on it (greenhouse/lever/ashby/…) — resolvable + pollable */
  | "ats"
  /** a company careers page on its own domain — resolvable later via page sniffing */
  | "careers"
  /** a third-party job board / aggregator listing (naukri, linkedin, instahyre, …) */
  | "job_board"
  /** a URL shortener / link-in-bio hop — destination unknown, low trust */
  | "shortener"
  /** chat / social / course-promo links — noise for job discovery */
  | "noise"
  | "other";

export interface ClassifiedLink {
  url: string;
  host: string;
  kind: LinkKind;
}

const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|jobs\.personio\.(de|com)|myworkdayjobs\.com|keka\.com|darwinbox\.in|zohorecruit\.(com|in)|freshteam\.com|skillate\.com|eightfold\.ai|icims\.com|taleo\.net|successfactors\.(com|eu)|oraclecloud\.com|breezy\.hr|jobvite\.com|teamtailor\.com|rippling\.com|bamboohr\.com|springworks\.in|hire\.trakstar\.com)$/i;
const JOB_BOARD_HOST = /(^|\.)(naukri\.com|linkedin\.com|lnkd\.in|instahyre\.com|wellfound\.com|angel\.co|cutshort\.io|hirist\.(tech|com)|iimjobs\.com|foundit\.in|monsterindia\.com|indeed\.(com|co\.in)|glassdoor\.(com|co\.in)|timesjobs\.com|shine\.com|apna\.co|internshala\.com|unstop\.com|ycombinator\.com|workatastartup\.com|himalayas\.app|remotive\.com|remoteok\.com|weworkremotely\.com|jobicy\.com|hasjob\.co|uplers\.com|turing\.com)$/i;
const SHORTENER_HOST = /(^|\.)(bit\.ly|tinyurl\.com|t\.ly|cutt\.ly|rb\.gy|shorturl\.at|is\.gd|ow\.ly|rebrand\.ly|linktr\.ee|bit\.do|tiny\.cc|shrtco\.de|gg\.gg|urlshortner\.\w+|gplinks\.\w+|adrinolinks\.\w+|shrinkme\.\w+|linkshortify\.\w+|artha\.link)$/i;
/**
 * Where job-channel links go to be monetised rather than applied to: ad-funded "job
 * relay" blogs and ed-tech course funnels (on most posts in several popular Indian
 * Telegram channels, 2026-09). Never a posting — dropped like any other noise.
 */
const FUNNEL_HOST = /(^|\.)(acciojob\.com|pdlink\.in|outskill\.com|scaler\.com|freshershunt\.in|job4freshers\.co\.in|careerstn\.com|foundthejob\.com|jobinvent\.com|fresheroffcampus\.com|jobfound\.org)$/i;
const NOISE_HOST = /(^|\.)(t\.me|telegram\.(me|org)|whatsapp\.com|wa\.me|chat\.whatsapp\.com|instagram\.com|facebook\.com|fb\.me|youtube\.com|youtu\.be|twitter\.com|x\.com|discord\.(gg|com)|play\.google\.com|apps\.apple\.com|topmate\.io|forms\.gle|docs\.google\.com|udemy\.com|coursera\.org|geeksforgeeks\.org|leetcode\.com)$/i;
const CAREERS_PATH = /\/(careers?|jobs?|join-us|joinus|work-with-us|open-positions|openings|vacancies|hiring)(\/|$|\?|#)/i;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** All http(s) URLs in a text blob, trailing punctuation trimmed, de-duplicated. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(URL_RE)) {
    out.add(m[0].replace(/[.,;:!?*_~]+$/, ""));
  }
  return [...out];
}

export function classifyLink(url: string): ClassifiedLink {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname;
  } catch {
    return { url, host: "", kind: "other" };
  }
  const kind: LinkKind = ATS_HOST.test(host)
    ? "ats"
    : JOB_BOARD_HOST.test(host)
      ? "job_board"
      : SHORTENER_HOST.test(host)
        ? "shortener"
        : NOISE_HOST.test(host) || FUNNEL_HOST.test(host)
          ? "noise"
          : CAREERS_PATH.test(path) || /^(careers?|jobs)\./.test(host)
            ? "careers"
            : "other";
  return { url, host, kind };
}
