import { describe, it, expect } from "vitest";
import { isSuspiciousMessage } from "../src/harvest.js";

describe("community scam / spam filter", () => {
  it.each([
    "Work from home job! Registration fee ₹499 only, direct joining",
    "Earn ₹3000 per day with simple tasks, daily payout",
    "Like and subscribe videos, get paid on Telegram",
    "100% job guarantee after our paid course — limited seats, enroll now",
    "Please pay the refundable security deposit to confirm your offer",
  ])("flags: %s", (msg) => {
    expect(isSuspiciousMessage(msg)).toBe(true);
  });

  it.each([
    "CRED hiring SDE-2 backend (2-5 yrs), Bengaluru — https://jobs.lever.co/cred/abc",
    "Razorpay is hiring across payments infra: https://razorpay.com/jobs/",
    "No interview-prep course needed, just apply on the careers page",
  ])("passes: %s", (msg) => {
    expect(isSuspiciousMessage(msg)).toBe(false);
  });
});

describe("fee mentions that are NOT asks (live-sample false positives)", () => {
  it.each([
    "Application Fee: Nil. Apply: https://jobs.lever.co/cred/abc",
    "No registration fee required — apply on the careers page",
    "Registration fee: none | Batch 2023-2025 | https://boards.greenhouse.io/x",
    "TCS NQT Registration open now",
    "SDE-2 at Razorpay https://boards.greenhouse.io/razorpaysoftwareprivatelimited — join our DSA course, limited seats!",
  ])("passes: %s", (msg) => {
    expect(isSuspiciousMessage(msg)).toBe(false);
  });

  it("still catches an ask hidden behind decorated / zero-width text", () => {
    const zw = String.fromCharCode(0x200b);
    expect(isSuspiciousMessage(`Pay ₹499 regis${zw}tration fee to confirm`)).toBe(true);
    expect(isSuspiciousMessage("𝐑𝐞𝐠𝐢𝐬𝐭𝐫𝐚𝐭𝐢𝐨𝐧 𝐟𝐞𝐞 ₹999")).toBe(true); // mathematical bold letters
  });
});
