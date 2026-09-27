import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Kula (Tier 2: the JSON behind careers.kula.ai pages, no auth) — used by Indian
 * fintech/SaaS startups whose roles never reach Greenhouse/Lever: Slice, Cashfree,
 * Acko, Rocketlane. Verified live 2026-09:
 *   GET https://careers.kula.ai/api/internal/ats_job_posts?accountName={slug}&type=ats_job_post.index&items=99&page=N
 * JD is inline; `launch_at` is the true publish date (matches the page's JSON-LD).
 * The path is literally /api/internal — undocumented, may change; degrades to [].
 */

interface KulaOffice {
  location?: string;
  country?: string;
  country_code?: string | null;
  city?: string;
  remote?: boolean;
}
interface KulaPost {
  id: number;
  title: string;
  listed?: boolean;
  launch_at?: string;
  end_at?: string | null;
  ats_job?: { job_description?: string; workplace?: string; offices?: KulaOffice[] };
}
interface KulaResponse {
  data?: KulaPost[];
  meta?: { pages?: number };
}

export class KulaAdapter implements SourceAdapter {
  readonly source = "kula" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const posts: KulaPost[] = [];
    for (let page = 1; page <= 10; page++) {
      const qs = new URLSearchParams({ accountName: slug, type: "ats_job_post.index", items: "99", page: String(page) });
      const res = await httpJson<KulaResponse>(`https://careers.kula.ai/api/internal/ats_job_posts?${qs}`);
      if (!res) return []; // all-or-nothing: a partial list would read as closed roles
      posts.push(...(res.data ?? []));
      if (page >= (res.meta?.pages ?? 1)) break;
    }
    return posts
      .filter((p) => p.listed !== false && (!p.end_at || new Date(p.end_at).getTime() > Date.now()))
      .map((p) => {
        const offices = p.ats_job?.offices ?? [];
        const places = offices.map((o) => o.location || [o.city, o.country].filter(Boolean).join(", ")).filter(Boolean);
        const workplace = p.ats_job?.workplace ?? "";
        const mode = /remote/i.test(workplace) || offices.some((o) => o.remote) ? "Remote - " : /hybrid/i.test(workplace) ? "Hybrid - " : "";
        return {
          source: "kula",
          tier: "tier2",
          atsType: "kula",
          atsJobId: String(p.id),
          companyName: slug,
          companySlug: slug,
          title: p.title.trim(),
          jdText: htmlToText(p.ats_job?.job_description),
          jdHtml: p.ats_job?.job_description ?? null,
          locationRaw: `${mode}${places.join("; ")}` || null,
          applyUrl: `https://careers.kula.ai/${slug}/${p.id}`,
          salaryRaw: null,
          postedAt: p.launch_at ?? null,
          fetchedAt: new Date(),
          raw: { id: p.id } as Record<string, unknown>,
        } satisfies RawPosting;
      });
  }
}
