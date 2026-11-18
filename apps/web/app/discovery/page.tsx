import { redirect } from "next/navigation";

/** Renamed: discovery settings live at /sources. */
export default function DiscoveryPage() {
  redirect("/sources");
}
