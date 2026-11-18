import Link from "next/link";
import { pageAuth } from "@/lib/auth";
import { AppFrame } from "@/components/AppFrame";
import { CompaniesView } from "@/components/CompaniesView";
import { Icon } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Every company JobFlow knows (from presets, your sources and discovery) — reached from Sources. */
export default async function CompaniesPage() {
  await pageAuth("/companies");
  return (
    <AppFrame
      wide
      title="Companies"
      eyebrow={
        <Link href="/sources">
          <Icon name="arrowLeft" size={14} /> Sources
        </Link>
      }
      intro="Every company JobFlow polls, from your presets, your own sources and what discovery found."
    >
      <CompaniesView />
    </AppFrame>
  );
}
