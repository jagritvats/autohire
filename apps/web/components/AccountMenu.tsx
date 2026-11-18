"use client";

import { useEffect, useState } from "react";

/** Signed-in email + sign out — only rendered on a multi-user instance (JOBFLOW_AUTH=password). */
export function AccountMenu() {
  const [me, setMe] = useState<{ mode: string; email: string | null; via: string } | null>(null);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  if (!me || me.mode !== "password" || me.via !== "session") return null;
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }
  return (
    <span className="account-menu">
      <span className="account-menu__email" title={`signed in as ${me.email}`}>
        {me.email}
      </span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={signOut}>
        sign out
      </button>
    </span>
  );
}
