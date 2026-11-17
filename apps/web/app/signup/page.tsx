import { redirect } from "next/navigation";
import { authMode } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { AuthForm } from "@/components/AuthForm";

export const dynamic = "force-dynamic";

export default async function SignupPage({ searchParams }: { searchParams: { next?: string } }) {
  if (authMode() !== "password") redirect("/");
  const firstUser = (await (await getRepo()).countUsers()) === 0;
  const open = firstUser || process.env.JOBFLOW_SIGNUP === "open";
  return (
    <main className="auth-shell">
      {open ? (
        <AuthForm mode="signup" next={searchParams.next ?? "/onboarding"} firstUser={firstUser} />
      ) : (
        <div className="auth-card">
          <h1 className="wordmark">
            Job<span className="flow">Flow</span>
          </h1>
          <p className="auth-sub">Sign-ups are closed on this instance. Ask the admin for an account.</p>
          <p className="auth-alt">
            <a href="/login">sign in</a>
          </p>
        </div>
      )}
    </main>
  );
}
