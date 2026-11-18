import { pageAuth } from "@/lib/auth";
import { AppFrame } from "@/components/AppFrame";
import { CompaniesView } from "@/components/CompaniesView";

export const dynamic = "force-dynamic";

/** Every company JobFlow knows (from presets, your sources and discovery) — reached from Sources. */
export default async function CompaniesPage() {
  await pageAuth("/companies");
  return (
    <AppFrame
      title="Companies"
      intro={
        <>
          <a href="/sources">← Sources</a> · every company JobFlow polls, from your presets, your own sources and what discovery found.
        </>
      }
    >
      <CompaniesView />
    </AppFrame>
  );
}
