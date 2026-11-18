import { pageAuth } from "@/lib/auth";
import { AppFrame } from "@/components/AppFrame";
import { ApplicationsView } from "@/components/ApplicationsView";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  await pageAuth("/applications");
  return (
    <AppFrame wide title="Applications" intro="Every job you've saved or applied to, where it stands, and what to do next.">
      <ApplicationsView />
    </AppFrame>
  );
}
