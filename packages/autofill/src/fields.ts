import type { AtsType } from "@jobflow/core";

/**
 * Per-ATS field selectors. Each logical field lists fallback selectors tried in
 * order (markup shifts). Greenhouse/Lever/Ashby/Workday are predictable enough that
 * this removes the tedious 80% while the human keeps every judgment (§7.1).
 */
export type FieldKey =
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "linkedin"
  | "github"
  | "portfolio"
  | "resume"
  | "location"
  | "company"
  | "coverLetter";

export type FieldSpec = {
  selectors: string[];
  kind: "text" | "email" | "tel" | "file" | "textarea";
};

export type AtsFieldMap = Partial<Record<FieldKey, FieldSpec>>;

const GREENHOUSE: AtsFieldMap = {
  firstName: { selectors: ["#first_name", "input[name='first_name']", "input[autocomplete='given-name']"], kind: "text" },
  lastName: { selectors: ["#last_name", "input[name='last_name']", "input[autocomplete='family-name']"], kind: "text" },
  email: { selectors: ["#email", "input[name='email']", "input[type='email']"], kind: "email" },
  phone: { selectors: ["#phone", "input[name='phone']", "input[type='tel']"], kind: "tel" },
  resume: { selectors: ["input[type='file'][name*='resume']", "#resume", "input[type='file']"], kind: "file" },
  linkedin: { selectors: ["input[name*='linkedin' i]", "input[id*='linkedin' i]"], kind: "text" },
  github: { selectors: ["input[name*='github' i]", "input[id*='github' i]"], kind: "text" },
  coverLetter: { selectors: ["#cover_letter_text", "textarea[name*='cover']"], kind: "textarea" },
};

const LEVER: AtsFieldMap = {
  fullName: { selectors: ["input[name='name']", "input[autocomplete='name']"], kind: "text" },
  email: { selectors: ["input[name='email']", "input[type='email']"], kind: "email" },
  phone: { selectors: ["input[name='phone']", "input[type='tel']"], kind: "tel" },
  company: { selectors: ["input[name='org']"], kind: "text" },
  resume: { selectors: ["input[type='file'][name='resume']", "input[type='file']"], kind: "file" },
  linkedin: { selectors: ["input[name='urls[LinkedIn]']", "input[name*='LinkedIn']"], kind: "text" },
  github: { selectors: ["input[name='urls[GitHub]']", "input[name*='GitHub']"], kind: "text" },
  portfolio: { selectors: ["input[name='urls[Portfolio]']", "input[name*='Portfolio']"], kind: "text" },
};

const ASHBY: AtsFieldMap = {
  fullName: { selectors: ["input[name='_systemfield_name']", "input[aria-label*='Name' i]"], kind: "text" },
  email: { selectors: ["input[name='_systemfield_email']", "input[type='email']"], kind: "email" },
  phone: { selectors: ["input[name*='phone' i]", "input[type='tel']"], kind: "tel" },
  resume: { selectors: ["input[type='file']"], kind: "file" },
  linkedin: { selectors: ["input[aria-label*='LinkedIn' i]", "input[name*='linkedin' i]"], kind: "text" },
};

const WORKABLE: AtsFieldMap = {
  firstName: { selectors: ["input[name='firstname']", "#firstname"], kind: "text" },
  lastName: { selectors: ["input[name='lastname']", "#lastname"], kind: "text" },
  email: { selectors: ["input[name='email']", "input[type='email']"], kind: "email" },
  phone: { selectors: ["input[name='phone']", "input[type='tel']"], kind: "tel" },
  resume: { selectors: ["input[type='file']"], kind: "file" },
};

// Workday is multi-step and account-gated; we map the common "My Information" step.
const WORKDAY: AtsFieldMap = {
  firstName: { selectors: ["input[data-automation-id='legalNameSection_firstName']"], kind: "text" },
  lastName: { selectors: ["input[data-automation-id='legalNameSection_lastName']"], kind: "text" },
  email: { selectors: ["input[data-automation-id='email']", "input[type='email']"], kind: "email" },
  phone: { selectors: ["input[data-automation-id='phone-number']", "input[type='tel']"], kind: "tel" },
  resume: { selectors: ["input[data-automation-id='file-upload-input-ref']", "input[type='file']"], kind: "file" },
};

/**
 * Conservative map for forms we have no dedicated map for (aggregator postings, unknown
 * or unmapped ATSes). Only the unambiguous contact fields, matched on the semantic
 * markers forms commonly carry (autocomplete tokens, name/id/placeholder/aria-label
 * words). Deliberately no bare `input[type='file']` fallback: on an unknown form the
 * first file input may well be a cover-letter or portfolio slot, and the human attaches
 * the résumé at review rather than us guessing (§7.1).
 */
const GENERIC: AtsFieldMap = {
  firstName: {
    selectors: [
      "input[autocomplete='given-name']",
      "input[name*='first' i][name*='name' i]",
      "input[id*='first' i][id*='name' i]",
      "input[placeholder*='first name' i]",
      "input[aria-label*='first name' i]",
    ],
    kind: "text",
  },
  lastName: {
    selectors: [
      "input[autocomplete='family-name']",
      "input[name*='last' i][name*='name' i]",
      "input[id*='last' i][id*='name' i]",
      "input[name*='surname' i]",
      "input[placeholder*='last name' i]",
      "input[aria-label*='last name' i]",
    ],
    kind: "text",
  },
  fullName: {
    selectors: [
      "input[autocomplete='name']",
      "input[name*='full' i][name*='name' i]",
      "input[id*='full' i][id*='name' i]",
      "input[placeholder*='full name' i]",
      "input[aria-label*='full name' i]",
    ],
    kind: "text",
  },
  email: {
    selectors: ["input[type='email']", "input[autocomplete='email']", "input[name*='email' i]", "input[id*='email' i]"],
    kind: "email",
  },
  phone: {
    selectors: ["input[type='tel']", "input[autocomplete='tel']", "input[name*='phone' i]", "input[id*='phone' i]", "input[name*='mobile' i]"],
    kind: "tel",
  },
  linkedin: {
    selectors: ["input[name*='linkedin' i]", "input[id*='linkedin' i]", "input[placeholder*='linkedin' i]", "input[aria-label*='linkedin' i]"],
    kind: "text",
  },
  github: {
    selectors: ["input[name*='github' i]", "input[id*='github' i]", "input[placeholder*='github' i]", "input[aria-label*='github' i]"],
    kind: "text",
  },
  resume: {
    selectors: [
      "input[type='file'][name*='resume' i]",
      "input[type='file'][id*='resume' i]",
      "input[type='file'][name*='cv' i]",
      "input[type='file'][id*='cv' i]",
      "input[type='file'][aria-label*='resume' i]",
    ],
    kind: "file",
  },
};

const MAPS: Record<string, AtsFieldMap> = {
  greenhouse: GREENHOUSE,
  lever: LEVER,
  ashby: ASHBY,
  workable: WORKABLE,
  workday: WORKDAY,
};

/** The generic map's identity, for callers that want to say which map a plan used. */
export const GENERIC_FIELD_MAP: Readonly<AtsFieldMap> = GENERIC;

/** true when `ats` has hand-written selectors (otherwise the generic map is used). */
export function hasDedicatedFieldMap(ats: string): boolean {
  return ats in MAPS;
}

/**
 * Field map for an ATS. Anything without a dedicated map — `unknown`, aggregator
 * postings, unmapped ATSes — gets the conservative generic map, never another ATS's
 * selectors (Greenhouse's `#first_name` etc. mean nothing on a random careers form).
 */
export function fieldMapFor(ats: AtsType | "workday" | "generic"): AtsFieldMap {
  return MAPS[ats] ?? GENERIC;
}
