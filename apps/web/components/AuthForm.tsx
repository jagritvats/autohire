"use client";

import { useState } from "react";

/** Email + password form for /login and /signup (JOBFLOW_AUTH=password). */
export function AuthForm({ mode, next, firstUser }: { mode: "login" | "signup"; next: string; firstUser?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      // only same-site relative paths — never an open redirect
      window.location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <h1 className="wordmark">
        Job<span className="flow">Flow</span>
      </h1>
      <p className="auth-sub">
        {mode === "login" ? "Sign in to your feed." : firstUser ? "Create the admin account for this instance." : "Create your account."}
      </p>
      <label className="auth-field">
        <span>email</span>
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>password</span>
        <input
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 10 : undefined}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" type="submit" disabled={busy}>
        {busy ? "…" : mode === "login" ? "sign in" : "create account"}
      </button>
      <p className="auth-alt">
        {mode === "login" ? (
          <a href={`/signup?next=${encodeURIComponent(next)}`}>no account? sign up</a>
        ) : (
          <a href={`/login?next=${encodeURIComponent(next)}`}>have an account? sign in</a>
        )}
      </p>
    </form>
  );
}
