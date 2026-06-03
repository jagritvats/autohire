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

const MAPS: Record<string, AtsFieldMap> = {
  greenhouse: GREENHOUSE,
  lever: LEVER,
  ashby: ASHBY,
  workable: WORKABLE,
  workday: WORKDAY,
};

export function fieldMapFor(ats: AtsType | "workday"): AtsFieldMap {
  return MAPS[ats] ?? GREENHOUSE; // greenhouse selectors are the most generic fallback
}
