import { NextResponse } from "next/server";
import { getFeed, getPostingsView, type PostingView } from "@/lib/feed";

export const dynamic = "force-dynamic";

const VIEWS: PostingView[] = ["bookmarks", "archived", "invalidated"];

/**
 * Secondary collections rendered as feed cards: `?view=bookmarks|archived|invalidated`.
 * Also `?india=1` — the ranked feed filtered to India-workable roles (a soft VIEW
 * filter, NOT a hard exclusion; the full feed is unchanged).
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.get("india") === "1" || params.get("india") === "true") {
    const data = await getFeed({ indiaOnly: true });
    return NextResponse.json({ cards: data.cards, india: true });
  }
  const view = params.get("view") ?? "bookmarks";
  if (!VIEWS.includes(view as PostingView)) {
    return NextResponse.json({ error: `view must be one of ${VIEWS.join(", ")}` }, { status: 400 });
  }
  const data = await getPostingsView(view as PostingView);
  return NextResponse.json(data);
}
