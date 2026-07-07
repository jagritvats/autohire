import { NextResponse } from "next/server";
import { importLinkedinSource } from "@/lib/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Import a LinkedIn data-export. The user uploads the CSVs from "Download your data"
 * (Positions.csv / Skills.csv / Profile.csv) — server-safe, no scraping, never holds a
 * LinkedIn session (invariant #1). We just parse the files they already own.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const entries = form.getAll("files").filter((f): f is File => f instanceof File);
  if (entries.length === 0) {
    return NextResponse.json({ error: "Upload at least one CSV (Positions.csv / Skills.csv / Profile.csv)." }, { status: 400 });
  }
  const csvs = entries.filter((f) => f.name.toLowerCase().endsWith(".csv"));
  if (csvs.length === 0) {
    return NextResponse.json({ error: "Only .csv files from the LinkedIn export are supported (unzip it first)." }, { status: 415 });
  }
  try {
    const files = await Promise.all(csvs.map(async (f) => ({ name: f.name, text: await f.text() })));
    return NextResponse.json(await importLinkedinSource(files));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
