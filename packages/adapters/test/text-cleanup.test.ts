import { describe, expect, it } from "vitest";
import { extractSkills, parseExperience } from "@jobflow/core";
import { cleanTitle, htmlToText } from "../src/types.js";

/**
 * 2026-11 feed review: Greenhouse sends `content` entity-ESCAPED, so the old htmlToText
 * stripped tags first and then unescaped them — JDs kept "<p><strong>About Us</strong>"
 * literally. Workday / SmartRecruiters numeric entities ("C&#43;&#43;", "3&#43; years",
 * "&#xa0;") were never decoded, hiding C++ and "3+ years" from the parsers. Fictional text.
 */
describe("htmlToText", () => {
  it("unescapes Greenhouse's escaped markup before stripping it", () => {
    const gh = "&lt;p&gt;&lt;strong&gt;About Us&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;Example Co builds ledgers.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Java &amp;amp; Kafka&lt;/li&gt;&lt;/ul&gt;";
    const t = htmlToText(gh);
    expect(t).not.toMatch(/<|&lt;|&amp;/);
    expect(t).toContain("About Us");
    expect(t).toContain("• Java & Kafka");
  });

  it("decodes numeric and named entities so parsers see the real text", () => {
    const wd = "<p>Strong C&#43;&#43; skills.&#xa0;3&#43; years of experience required. D&eacute;fense &mdash; R&amp;D.</p>";
    const t = htmlToText(wd);
    expect(t).toBe("Strong C++ skills. 3+ years of experience required. Défense — R&D.");
    expect(extractSkills(t)).toContain("cpp");
    expect(parseExperience(t).min).toBe(3);
  });

  it("keeps ordinary prose with a literal ampersand or angle bracket", () => {
    expect(htmlToText("Latency &lt; 10ms for P&amp;L systems")).toBe("Latency < 10ms for P&L systems");
  });
});

describe("cleanTitle", () => {
  it("decodes entities and drops a repeated comma segment", () => {
    expect(cleanTitle("VP of Partnerships &amp; Growth")).toBe("VP of Partnerships & Growth");
    expect(cleanTitle("Software Development Engineer, Middle Mile, Middle Mile, Yard Automation")).toBe("Software Development Engineer, Middle Mile, Yard Automation");
    expect(cleanTitle("  Senior   Engineer ")).toBe("Senior Engineer");
    expect(cleanTitle("Principal, Senior, Distinguished Engineer")).toBe("Principal, Senior, Distinguished Engineer");
  });
});
