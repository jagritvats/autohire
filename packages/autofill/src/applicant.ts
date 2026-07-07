import type { Contact } from "@jobflow/core";
import type { ApplicantData } from "./plan.js";

/** Map the profile's stored Contact → autofill ApplicantData. Only real, stored
 *  values are ever typed into a form; answers are passed through (§3, §7.1). */
export function mapContactToApplicant(
  contact: Contact,
  answers: Record<string, string> = {},
): ApplicantData {
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone || undefined,
    linkedin: contact.linkedin || undefined,
    github: contact.github || undefined,
    portfolio: contact.portfolio || undefined,
    resumePath: contact.resumePath || undefined,
    answers,
  };
}
