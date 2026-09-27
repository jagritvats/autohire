import { describe, it, expect } from "vitest";
import { classifyLink, extractLinks, parseWhatsAppExport } from "../src/normalize/index.js";

describe("link extraction + classification (community channels)", () => {
  it("pulls URLs out of prose and trims trailing punctuation", () => {
    const links = extractLinks("Apply: https://jobs.lever.co/cred/abc-123. Also see https://bit.ly/x1!");
    expect(links).toEqual(["https://jobs.lever.co/cred/abc-123", "https://bit.ly/x1"]);
  });

  it.each([
    ["https://job-boards.greenhouse.io/phonepe/jobs/123", "ats"],
    ["https://jobs.ashbyhq.com/notion/uuid", "ats"],
    ["https://walmart.wd5.myworkdayjobs.com/WalmartExternal/job/x", "ats"],
    ["https://razorpay.keka.com/careers/jobdetails/1", "ats"],
    ["https://www.naukri.com/job-listings-x", "job_board"],
    ["https://www.linkedin.com/jobs/view/123", "job_board"],
    ["https://bit.ly/abc", "shortener"],
    ["https://t.me/somechannel", "noise"],
    ["https://chat.whatsapp.com/invite", "noise"],
    ["https://zerodha.com/careers/", "careers"],
    ["https://careers.swiggy.com/#/", "careers"],
    ["https://example.com/blog", "other"],
  ])("%s → %s", (url, kind) => {
    expect(classifyLink(url).kind).toBe(kind);
  });
});

describe("WhatsApp export parsing", () => {
  it("parses Android exports day-first, folding continuation lines", () => {
    const txt = [
      "12/09/2026, 10:15 - Messages and calls are end-to-end encrypted.",
      "12/09/2026, 10:16 - Asha: Hiring SDE-2 backend at CRED",
      "Apply: https://jobs.lever.co/cred/abc",
      "13/09/2026, 9:05 pm - Ravi: <Media omitted>",
    ].join("\n");
    const msgs = parseWhatsAppExport(txt);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain("https://jobs.lever.co/cred/abc");
    expect(msgs[0]!.postedAt?.getMonth()).toBe(8); // September, i.e. day-first
    expect(msgs[0]!.postedAt?.getDate()).toBe(12);
  });

  it("parses iOS bracketed exports with 12h clocks", () => {
    const msgs = parseWhatsAppExport("[26/09/26, 9:05:30 PM] Referrals India: Razorpay is hiring https://razorpay.com/jobs/");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.postedAt?.getHours()).toBe(21);
    expect(msgs[0]!.postedAt?.getFullYear()).toBe(2026);
  });
});

describe("promo funnels are noise, not postings", () => {
  it.each(["https://go.acciojob.com/abc", "https://pdlink.in/x", "https://freshershunt.in/job", "https://artha.link/q"])("%s", (url) => {
    expect(["noise", "shortener"]).toContain(classifyLink(url).kind);
  });
});
