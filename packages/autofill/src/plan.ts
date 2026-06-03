import type { AtsType } from "@jobflow/core";
import { fieldMapFor, type FieldKey, type FieldSpec } from "./fields.js";

/** The applicant's known data — the autofill source of truth (never invented). */
export interface ApplicantData {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  location?: string;
  resumePath?: string;
  coverLetter?: string;
  /** tailored, evidence-grounded answers keyed by a normalized question */
  answers?: Record<string, string>;
}

export interface PlannedField {
  field: FieldKey;
  selectors: string[];
  kind: FieldSpec["kind"];
  value: string;
  /** true if this is a file upload (value = path) */
  isFile: boolean;
}

export interface FillPlan {
  ats: AtsType | "workday";
  url: string;
  fields: PlannedField[];
  /** free-text question fields matched fuzzily against the applicant's answers */
  questionFields: Array<{ question: string; answer: string }>;
  /** fields we have a selector for but NO value → human must fill at review */
  unfilled: FieldKey[];
}

/**
 * Build the fill plan (pure). The runner executes it up to the review gate; dry-run
 * just renders it. Resolving values here (not in the browser) keeps the dangerous
 * part — page interaction — tiny and auditable.
 */
export function buildFillPlan(
  ats: AtsType | "workday",
  url: string,
  data: ApplicantData,
): FillPlan {
  const map = fieldMapFor(ats);
  const value: Partial<Record<FieldKey, string>> = {
    firstName: data.firstName,
    lastName: data.lastName,
    fullName: `${data.firstName} ${data.lastName}`.trim(),
    email: data.email,
    phone: data.phone,
    linkedin: data.linkedin,
    github: data.github,
    portfolio: data.portfolio,
    location: data.location,
    resume: data.resumePath,
    coverLetter: data.coverLetter,
  };

  const fields: PlannedField[] = [];
  const unfilled: FieldKey[] = [];

  for (const key of Object.keys(map) as FieldKey[]) {
    const spec = map[key]!;
    const v = value[key];
    if (v && v.trim()) {
      fields.push({
        field: key,
        selectors: spec.selectors,
        kind: spec.kind,
        value: v,
        isFile: spec.kind === "file",
      });
    } else {
      unfilled.push(key);
    }
  }

  const questionFields = Object.entries(data.answers ?? {}).map(([question, answer]) => ({
    question,
    answer,
  }));

  return { ats, url, fields, questionFields, unfilled };
}

/** Human-readable dry-run of what WOULD be filled — never touches a page (§7.1). */
export function renderDryRun(plan: FillPlan): string {
  const lines: string[] = [];
  lines.push(`DRY RUN · ${plan.ats} · ${plan.url}`);
  lines.push(`Would fill ${plan.fields.length} fields:`);
  for (const f of plan.fields) {
    const shown = f.isFile ? `📎 ${f.value}` : truncate(f.value, 60);
    lines.push(`  • ${f.field.padEnd(12)} → ${shown}`);
  }
  if (plan.questionFields.length) {
    lines.push(`Would draft ${plan.questionFields.length} answer field(s):`);
    for (const q of plan.questionFields) lines.push(`  ? ${truncate(q.question, 50)} → ${truncate(q.answer, 50)}`);
  }
  if (plan.unfilled.length) {
    lines.push(`Left for human at review (no value): ${plan.unfilled.join(", ")}`);
  }
  lines.push(`NOTE: never submits. Stops at the review screen for human edit + submit.`);
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
