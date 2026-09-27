import { describe, it, expect } from "vitest";
import { parseTelegramPreview } from "../src/community/telegram.js";

const PAGE = `
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="jobsin/101">
  <div class="tgme_widget_message_text js-message_text" dir="auto">🚀 CRED is hiring SDE-2 (2-5 yrs)<br/>Apply: <a href="https://jobs.lever.co/cred/abc-123" target="_blank">link</a></div>
  <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="https://t.me/jobsin/101"><time datetime="2026-09-25T10:15:00+00:00" class="time">10:15</time></a></div>
</div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="jobsin/102">
  <div class="tgme_widget_message_text js-message_text" dir="auto">Batch 2025 freshers!</div>
  <div class="tgme_widget_message_footer"><time datetime="2026-09-26T08:00:00+00:00" class="time">08:00</time></div>
</div></div>`;

describe("Telegram public preview parsing", () => {
  it("extracts text, hrefs behind anchor labels, timestamps and post refs", () => {
    const msgs = parseTelegramPreview(PAGE);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.ref).toBe("jobsin/101");
    expect(msgs[0]!.text).toContain("https://jobs.lever.co/cred/abc-123");
    expect(msgs[0]!.text).toContain("CRED is hiring SDE-2");
    expect(msgs[0]!.postedAt?.toISOString()).toBe("2026-09-25T10:15:00.000Z");
  });
});
