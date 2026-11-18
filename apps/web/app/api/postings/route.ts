import { NextResponse } from "next/server";
import { getFeed, getPostingsView, type PostingView } from "@/lib/feed";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

const VIEWS: PostingView[] = ["bookmarks", "archived", "invalidated"];

/**
 * Secondary collections rendered as feed cards: `?view=bookmarks|archived|invalidated`.
 * Also `?workable=1` — the ranked feed filtered to roles workable for you (your home
 * country, markets and remote regions; `?india=1` is the old spelling) — a soft VIEW
 * filter, NOT a hard exclusion; the full feed is unchanged.
 */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const params = new URL(req.url).searchParams;
  const flag = (k: string) => params.get(k) === "1" || params.get(k) === "true";
  if (flag("workable") || flag("india")) {
    const data = await getFeed(auth.tenantId, { workableOnly: true });
    return NextResponse.json({ cards: data.cards, workable: true });
  }
  // `?search=<saved search id>` — the ranked feed through one of your saved searches as a
  // VIEW: it hides only on confidently-known values and reports what it hid (never silent)
  const search = params.get("search");
  if (search) {
    const data = await getFeed(auth.tenantId, { view: search });
    return NextResponse.json({ cards: data.cards, search, hidden: data.stats.hidden ?? null, hiddenTotal: data.stats.hiddenTotal ?? 0 });
  }
  const view = params.get("view") ?? "bookmarks";
  // `?view=feed` — the whole Jobs feed again (the Jobs page reloads it after a sync)
  if (view === "feed") return NextResponse.json(await getFeed(auth.tenantId, { bootstrap: false }));
  if (!VIEWS.includes(view as PostingView)) {
    return NextResponse.json({ error: `view must be one of ${VIEWS.join(", ")}` }, { status: 400 });
  }
  const data = await getPostingsView(auth.tenantId, view as PostingView);
  return NextResponse.json(data);
}
