"use client";

import { useState, useTransition } from "react";
import { formatPay, type PayDisplay } from "@jobflow/core";

/** display currencies offered (any ISO code with a known rate also works via the CLI) */
const CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD", "SGD", "CHF", "SEK", "NOK", "DKK", "PLN", "JPY", "BRL", "MXN", "AED"];

/**
 * "Show pay in" (§11.4): the posting's own currency and period always lead; this adds a
 * converted figure in the reader's currency, per year or per month. Display only — the
 * salary floor and every comparison run on annual figures in one currency regardless.
 */
export function PayDisplayForm({ initial, homeCurrency, rateDate }: { initial: PayDisplay; homeCurrency: string | null; rateDate: string }) {
  const [display, setDisplay] = useState<PayDisplay>(initial);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const want = display.currency === "auto" ? homeCurrency : display.currency === "none" ? null : display.currency;
  // two fictional postings, rendered by the same formatter the cards use
  const example = [
    formatPay({ min: 3_000_000, max: 4_500_000, currency: "INR", period: "year" }, { currency: want, period: display.period }),
    formatPay({ min: 66_000, max: 78_000, currency: "EUR", period: "month" }, { currency: want, period: display.period }),
  ]
    .map((f) => f?.text)
    .filter(Boolean)
    .join("  ·  ");

  const save = () =>
    start(async () => {
      const res = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefs: { display } }) });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? { text: "Saved. Cards now show pay this way." } : { text: body.error ?? "Couldn't save.", bad: true });
    });

  return (
    <section className="card-block" id="pay">
      <h2>Pay display</h2>
      <p className="hint">
        Pay is always shown as the posting states it — its currency and its period. Add a converted figure in your currency, per year or per month.
        Estimates stay marked “est.”. Conversions use ECB reference rates (as of {rateDate}).
      </p>
      <div className="field-row">
        <label>
          show pay in
          <select value={display.currency} onChange={(e) => setDisplay({ ...display, currency: e.target.value })}>
            <option value="auto">{homeCurrency ? `my home currency (${homeCurrency})` : "my home currency (set a home country)"}</option>
            <option value="none">the posting's currency only</option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          converted figure
          <select value={display.period} onChange={(e) => setDisplay({ ...display, period: e.target.value === "month" ? "month" : "year" })}>
            <option value="year">per year</option>
            <option value="month">per month</option>
          </select>
        </label>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        e.g. <b>{example}</b>
      </p>
      <div className="field-row" style={{ marginTop: 10, alignItems: "center" }}>
        <button className="save" onClick={save} disabled={pending}>
          {pending ? "saving…" : "Save"}
        </button>
        {msg && (
          <p className={msg.bad ? "auth-error" : "notice"} role={msg.bad ? "alert" : "status"}>
            {msg.text}
          </p>
        )}
      </div>
    </section>
  );
}
