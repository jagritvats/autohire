import { redirect } from "next/navigation";

/** Renamed: Search lives at /search. */
export default function SearchesPage() {
  redirect("/search");
}
