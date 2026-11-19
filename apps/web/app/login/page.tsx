import { redirect } from "next/navigation";
import { authMode } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { AuthForm } from "@/components/AuthForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (authMode() !== "password") redirect("/");
  // a brand-new instance has no accounts yet — send the first visitor to create the admin
  if ((await (await getRepo()).countUsers()) === 0) redirect(`/signup?next=${encodeURIComponent(next ?? "/")}`);
  return (
    <div className="auth-shell">
      <AuthForm mode="login" next={next ?? "/"} />
    </div>
  );
}
