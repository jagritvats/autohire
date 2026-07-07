import { NextResponse } from "next/server";
import { getPostingsView, type PostingView } from "@/lib/feed";

export const dynamic = "force-dynamic";

const VIEWS: PostingView[] = ["bookmarks", "archived", "invalidated"];

/** Secondary collections rendered as feed cards: ?view=bookmarks|archived|invalidated. */
export async function GET(req: Request) {
  const view = new URL(req.url).searchParams.get("view") ?? "bookmarks";
  if (!VIEWS.includes(view as PostingView)) {
    return NextResponse.json({ error: `view must be one of ${VIEWS.join(", ")}` }, { status: 400 });
  }
  const data = await getPostingsView(view as PostingView);
  return NextResponse.json(data);
}
