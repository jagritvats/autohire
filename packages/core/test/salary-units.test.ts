import { afterEach, describe, expect, it } from "vitest";
import {
  FX_AS_OF,
  STATIC_FX,
  activeFx,
  comparablePay,
  convertCurrency,
  convertWithInfo,
  currencyMismatch,
  describePay,
  extractSalaryFromText,
  formatAmount,
  formatPay,
  fxUncertainty,
  installFxRates,
  parseLocation,
  parseMoneyInput,
  parseStatedSalary,
  payDisplayOptions,
  payForSort,
  resetFxRates,
  resolveDisplayCurrency,
  scorePosting,
  statedCeilingBelow,
  type Posting,
  type Profile,
  type SalaryBand,
  type SalaryParseOptions,
} from "../src/index.js";

// Units, periods and currencies, end to end (§11.4). Every string is fictional, written in
// the shapes boards and JDs actually use.

type Want = Partial<Pick<SalaryBand, "currency" | "period" | "min" | "max" | "confidence" | "basis" | "equity">> | null;
const US: SalaryParseOptions = { country: "US" };
const at = (country: string | null): SalaryParseOptions => ({ country });

describe("stated salary: units, periods, currencies (table)", () => {
  const cases: Array<[string, SalaryParseOptions, Want]> = [
    // ── per year ──
    ["Salary: $120,000 – $150,000 per year", US, { currency: "USD", period: "year", min: 120_000, max: 150_000, confidence: "high" }],
    ["Pay range: $120k-$150k/yr", US, { currency: "USD", period: "year", min: 120_000, max: 150_000, confidence: "high" }],
    ["Salary range: 120,000 - 150,000 USD annually", US, { currency: "USD", period: "year", max: 150_000, confidence: "high" }],
    ["Compensation: $95,000/yr – $120,000/yr", US, { period: "year", min: 95_000, max: 120_000, confidence: "high" }],
    ["Salary: £45,000 - £55,000 per annum + benefits", at("GB"), { currency: "GBP", period: "year", min: 45_000, max: 55_000, confidence: "high" }],
    ["Salary: £45k-£55k pa", at("GB"), { currency: "GBP", period: "year", min: 45_000, max: 55_000, confidence: "high" }],
    ["Salary: CHF 120'000 – 140'000 p.a.", at("CH"), { currency: "CHF", period: "year", min: 120_000, max: 140_000, confidence: "high" }],
    ["Salary: €60.000 - €70.000 per year", at("DE"), { currency: "EUR", period: "year", min: 60_000, max: 70_000, confidence: "high" }],
    ["Salaire : 55 000 € - 65 000 € par an", at("FR"), { currency: "EUR", period: "year", min: 55_000, max: 65_000, confidence: "high" }],
    ["Salary: €70K – €90K per year, depending on experience", at("NL"), { currency: "EUR", min: 70_000, max: 90_000, confidence: "high" }],
    ["Salary: ZAR 600 000 – 800 000 per annum", at("ZA"), { currency: "ZAR", period: "year", min: 600_000, max: 800_000, confidence: "high" }],
    ["Salary: ¥8,000,000 - ¥10,000,000", at("JP"), { currency: "JPY", period: "year", max: 10_000_000, confidence: "high" }],
    ["Salary: up to £80,000 per annum", at("GB"), { currency: "GBP", min: null, max: 80_000, confidence: "high" }],
    // ── per month ──
    ["Salary: €5,500 – €6,500 gross per month", at("DE"), { currency: "EUR", period: "month", min: 66_000, max: 78_000, confidence: "high" }],
    ["Gehalt: 4.500 € - 5.500 € brutto monatlich", at("DE"), { currency: "EUR", period: "month", min: 54_000, max: 66_000, confidence: "high" }],
    ["Monthly salary: SGD 6,000 - 8,000", at("SG"), { currency: "SGD", period: "month", min: 72_000, max: 96_000, confidence: "high" }],
    ["Salary: S$8,000 – S$10,000 monthly", at("SG"), { currency: "SGD", period: "month", min: 96_000, max: 120_000, confidence: "high" }],
    ["Salary: HK$40,000 – HK$55,000 per month", at("HK"), { currency: "HKD", period: "month", min: 480_000, max: 660_000, confidence: "high" }],
    ["Lön: 45 000 – 55 000 kr per månad", at("SE"), { currency: "SEK", period: "month", min: 540_000, max: 660_000, confidence: "high" }],
    ["Salary: DKK 45.000 - 55.000 per month", at("DK"), { currency: "DKK", period: "month", min: 540_000, max: 660_000, confidence: "high" }],
    ["Wynagrodzenie: 15 000 – 20 000 zł brutto miesięcznie", at("PL"), { currency: "PLN", period: "month", min: 180_000, max: 240_000, confidence: "high" }],
    ["Salary: 18 000 - 24 000 PLN/mo", at("PL"), { currency: "PLN", period: "month", min: 216_000, max: 288_000, confidence: "high" }],
    ["Salary: R$ 12.000 - R$ 15.000 por mês", at("BR"), { currency: "BRL", period: "month", min: 144_000, max: 180_000, confidence: "high" }],
    ["Salary: MX$40,000 - MX$55,000 monthly", at("MX"), { currency: "MXN", period: "month", min: 480_000, max: 660_000, confidence: "high" }],
    ["Salary: $40,000 - $55,000 MXN monthly", at("MX"), { currency: "MXN", period: "month", max: 660_000, confidence: "high" }],
    ["Salary: AED 25,000 - 30,000 per month", at("AE"), { currency: "AED", period: "month", min: 300_000, max: 360_000, confidence: "high" }],
    ["Salary: ¥30,000 – ¥40,000 per month", at("CN"), { currency: "CNY", period: "month", min: 360_000, max: 480_000, confidence: "high" }],
    ["USD 5,000–7,000/month", { ...US, structured: true }, { currency: "USD", period: "month", min: 60_000, max: 84_000, confidence: "high" }],
    // period not written, but too small for a year: read as monthly, never high
    ["Salary: €4,500 – €5,500", at("DE"), { currency: "EUR", period: "month", min: 54_000, max: 66_000, confidence: "medium_high" }],
    ["Salary: ₹50,000 – ₹70,000", at("IN"), { currency: "INR", period: "month", min: 600_000, max: 840_000, confidence: "medium_high" }],
    // ── per week / day / hour: annualised, never high ──
    ["Weekly pay: £800 - £1,000", at("GB"), { currency: "GBP", period: "week", min: 41_600, max: 52_000, confidence: "medium_high" }],
    ["Salary: $2,000 per week", US, { period: "week", min: 104_000, max: null, confidence: "medium_high" }],
    ["Day rate: £500 - £600", at("GB"), { currency: "GBP", period: "day", min: 130_000, max: 156_000, confidence: "medium_high" }],
    ["Daily rate: £550", at("GB"), { currency: "GBP", period: "day", min: 143_000, confidence: "medium_high" }],
    ["Pay: $55–$70 per hour", US, { currency: "USD", period: "hour", min: 114_400, max: 145_600, confidence: "medium_high" }],
    ["Hourly rate: $45 - $60", US, { period: "hour", min: 93_600, max: 124_800, confidence: "medium_high" }],
    ["Compensation: $35/h", US, { period: "hour", min: 72_800, max: null, confidence: "medium_high" }],
    ["We pay $60 an hour for this contract.", US, { period: "hour", min: 124_800, confidence: "medium_high" }],
    ["Pay: $50/hr – $70/hr", US, { period: "hour", min: 104_000, max: 145_600 }],
    // ── India: LPA, lakh, crore, CTC, stipends ──
    ["CTC: ₹18 – 24 LPA", at("IN"), { currency: "INR", period: "year", min: 1_800_000, max: 2_400_000, confidence: "high" }],
    ["Salary: 12-18 LPA", at("IN"), { currency: "INR", period: "year", min: 1_200_000, max: 1_800_000, confidence: "high" }],
    ["Salary: ₹30L – ₹45L per annum", at("IN"), { currency: "INR", min: 3_000_000, max: 4_500_000, confidence: "high" }],
    ["CTC: Rs. 15,00,000 - 20,00,000 p.a.", at("IN"), { currency: "INR", period: "year", min: 1_500_000, max: 2_000_000, confidence: "high" }],
    ["Package: 1.2 Cr - 1.5 Cr", at("IN"), { currency: "INR", min: 12_000_000, max: 15_000_000, confidence: "high" }],
    ["Salary up to 40 Lakhs per annum", at("IN"), { currency: "INR", min: null, max: 4_000_000, confidence: "high" }],
    ["CTC upto ₹35 L", at("IN"), { currency: "INR", max: 3_500_000, confidence: "high" }],
    ["Salary: INR 50,000 - 70,000 per month", at("IN"), { currency: "INR", period: "month", min: 600_000, max: 840_000, confidence: "high" }],
    ["Stipend: ₹25,000/month", at("IN"), { currency: "INR", period: "month", min: 300_000, max: null, confidence: "medium_high" }],
    ["Stipend: Rs 15000 pm", at("IN"), { currency: "INR", period: "month", min: 180_000, confidence: "medium_high" }],
    ["Monthly CTC: ₹1,50,000", at("IN"), { currency: "INR", period: "month", min: 1_800_000, confidence: "medium_high" }],
    ["CTC: ₹2L – ₹2.5L", at("IN"), { currency: "INR", period: "year", max: 250_000, confidence: "medium_high" }],
    ["Salary 18–22 LPA + ESOPs", at("IN"), { currency: "INR", max: 2_200_000, equity: true, confidence: "high" }],
    // ── a bare "$" is resolved from where the posting is ──
    ["Salary: $120,000 - $140,000", at("CA"), { currency: "CAD", confidence: "medium_high" }],
    ["Salary: $120,000 - $140,000", at("AU"), { currency: "AUD", confidence: "medium_high" }],
    ["Salary: $120,000 - $140,000", at("NZ"), { currency: "NZD", confidence: "medium_high" }],
    ["Salary: $6,000 – $8,000 per month", at("SG"), { currency: "SGD", period: "month", confidence: "medium_high" }],
    ["Salary: $120,000 - $140,000", at("GB"), { currency: "USD", confidence: "medium_high" }],
    ["Salary: $120,000 - $140,000", at(null), { currency: "USD", confidence: "medium_high" }],
    ["Salary: $120,000 - $140,000", US, { currency: "USD", confidence: "high" }],
    ["Salary: A$140k – A$160k + super", at("AU"), { currency: "AUD", min: 140_000, max: 160_000, confidence: "high" }],
    ["Compensation: CA$110,000–CA$130,000", at("CA"), { currency: "CAD", min: 110_000, max: 130_000, confidence: "high" }],
    ["Base salary: US$150,000 – US$180,000", at("GB"), { currency: "USD", basis: "base", confidence: "high" }],
    ["Salary: 600 000 – 700 000 kr per year", at("NO"), { currency: "NOK", period: "year", min: 600_000, max: 700_000, confidence: "high" }],
    ["Salary: kr 45 000 per month", at(null), null], // a krona nobody can name is never priced
    // ── base / OTE / total, and equity (never pay) ──
    ["OTE: $180k – $220k", US, { basis: "ote", min: 180_000, max: 220_000, confidence: "high" }],
    [
      "The typical starting salary range for this role is: $129,000 – $204,000 USD The typical starting Target Variable range for this role is: $55,200 – $87,400 USD The typical starting On-Target Earnings (OTE) range for this role is: $184,200 – $291,400 USD",
      US,
      { min: 129_000, max: 204_000, confidence: "high" }, // variable pay is not salary; OTE isn't unioned in
    ],
    ["Commission: $40,000 – $60,000 at target. Base salary: $90,000 – $110,000.", US, { min: 90_000, max: 110_000, basis: "base" }],
    ["Base salary $140,000 - $160,000; OTE $280,000 - $320,000", US, { basis: "base", min: 140_000, max: 160_000 }],
    ["Total compensation: $250k – $350k (base + equity)", US, { basis: "total", equity: true }],
    ["Salary: $150k–$190k + equity", US, { min: 150_000, max: 190_000, equity: true, confidence: "high" }],
    ["Salary: $150,000 - $190,000 plus stock options", US, { equity: true }],
    ["$150k – $190k • 0.5% – 1.0%", { ...US, structured: true }, { max: 190_000, equity: true, confidence: "high" }],
    ["Compensation includes $20,000 in RSUs.", US, null],
    ["Estimated annual salary of $117,000 - $161,000 Equity This role is eligible for our equity plan.", US, { min: 117_000, max: 161_000, confidence: "high" }],
    ["Salary: $150,000 - $180,000. Equity grants vest over four years.", US, { max: 180_000, confidence: "high" }],
    ["You'll get $40,000 equity grants yearly.", US, null],
    ["Equity: 0.1% – 0.5%", US, null],
    // ── not pay ──
    ["Salary: $1.2M - $1.5M", US, null],
    ["We raised $5M in our Series A.", US, null],
    ["Pay: $25 - $35", US, null], // neither a year's nor a month's pay; hourly is never guessed
    ["Join a team of 2 000 engineers across 3 continents.", US, null],
  ];

  it(`has a broad table (${cases.length} strings)`, () => expect(cases.length).toBeGreaterThanOrEqual(60));

  it.each(cases)("%s  %j", (text, opts, want) => {
    const got = extractSalaryFromText(text, opts);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatchObject(want);
  });
});

describe("the posting's location prices its salary", () => {
  it("a Toronto posting's '$' is CAD; a US one's is USD; an unplaced remote one's is USD, but not high", () => {
    const text = "Salary: $120,000 - $140,000";
    expect(parseStatedSalary(null, text, parseLocation("Toronto, Canada"))).toMatchObject({ currency: "CAD", confidence: "medium_high" });
    expect(parseStatedSalary(null, text, parseLocation("Austin, TX"))).toMatchObject({ currency: "USD", confidence: "high" });
    expect(parseStatedSalary(null, text, parseLocation("Remote", "Remote — US only"))).toMatchObject({ currency: "USD", confidence: "high" });
    expect(parseStatedSalary(null, text, parseLocation("Remote"))).toMatchObject({ currency: "USD", confidence: "medium_high" });
    // a multi-office role with a US office (and no other dollar country) posts US dollars
    expect(parseStatedSalary(null, text, parseLocation("Bengaluru, India; San Jose, CA"))).toMatchObject({ currency: "USD", confidence: "high" });
  });
});

describe("parseMoneyInput — typed floors and filters use the same grammar", () => {
  it.each([
    ["40L INR", null, { amount: 4_000_000, currency: "INR", period: "year" }],
    ["40 LPA", null, { amount: 4_000_000, currency: "INR", period: "year" }],
    ["₹30 LPA", null, { amount: 3_000_000, currency: "INR", period: "year" }],
    ["$120k", null, { amount: 120_000, currency: "USD", period: "year" }],
    ["150k USD", null, { amount: 150_000, currency: "USD" }],
    ["150k usd", null, { amount: 150_000, currency: "USD" }],
    ["150000USD", null, { amount: 150_000, currency: "USD" }],
    ["5000 EUR/mo", null, { amount: 60_000, currency: "EUR", period: "month" }],
    ["€5,000 per month", null, { amount: 60_000, currency: "EUR", period: "month" }],
    ["60k GBP per year", null, { amount: 60_000, currency: "GBP", period: "year" }],
    ["€50/hr", null, { amount: 104_000, currency: "EUR", period: "hour" }],
    ["1.5 cr", null, { amount: 15_000_000, currency: "INR" }],
    ["150000", "EUR", { amount: 150_000, currency: "EUR" }],
    ["CHF 120'000", null, { amount: 120_000, currency: "CHF" }],
  ] as const)("%s", (text, cur, want) => {
    expect(parseMoneyInput(text, cur)).toMatchObject(want);
  });
  it("rejects what isn't an amount", () => {
    expect(parseMoneyInput("lots")).toBeNull();
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput(0)).toBeNull();
    expect(parseMoneyInput(90_000, "GBP")).toEqual({ amount: 90_000, currency: "GBP", period: "year" });
  });
});

// ── FX ──
describe("FX: a dated static table, optionally refreshed", () => {
  afterEach(() => resetFxRates());

  it("converts through USD at the shipped rate, and never guesses an unknown currency", () => {
    expect(convertCurrency(93.44, "INR", "USD")).toBeCloseTo(1, 6);
    expect(convertCurrency(100, "EUR", "EUR")).toBe(100);
    expect(convertCurrency(100, "XYZ", "USD")).toBeNull();
    const c = convertWithInfo(3_000_000, "INR", "USD", { now: new Date(`${FX_AS_OF}T12:00:00Z`) })!;
    expect(c.amount).toBeCloseTo(32_106, 0);
    expect(c.rateDate).toBe(FX_AS_OF);
    expect(c.converted).toBe(true);
    expect(convertWithInfo(5, "USD", "USD")).toMatchObject({ converted: false, rateDate: null, uncertainty: 0 });
  });

  it("installs a NEWER valid table only; older or broken ones are ignored", () => {
    const newer = { asOf: "2099-01-02", source: "ECB via frankfurter", perUsd: { USD: 1, INR: 100, EUR: 0.9, GBP: 0.8, CAD: 1.4, AUD: 1.5 } };
    expect(installFxRates({ ...newer, asOf: "2001-01-01" }).asOf).toBe(FX_AS_OF);
    expect(installFxRates({ ...newer, perUsd: { USD: 1, INR: -3 } }).asOf).toBe(FX_AS_OF);
    expect(installFxRates(newer).asOf).toBe("2099-01-02");
    expect(convertCurrency(100, "INR", "USD")).toBeCloseTo(1, 6);
    expect(convertCurrency(1, "USD", "AED")).toBeCloseTo(3.6725, 4); // the peg survives a refresh without it
    expect(activeFx().source).toBe("ECB via frankfurter");
    resetFxRates();
    expect(activeFx()).toBe(STATIC_FX);
  });

  it("a stale rate is less certain (3% + 1%/month, ≤ 15%)", () => {
    const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
    expect(fxUncertainty(STATIC_FX, d(FX_AS_OF))).toBeCloseTo(0.03, 6);
    expect(fxUncertainty(STATIC_FX, new Date(d(FX_AS_OF).getTime() + 90 * 86_400_000))).toBeCloseTo(0.06, 6);
    expect(fxUncertainty(STATIC_FX, d("2099-01-01"))).toBe(0.15);
  });
});

// ── the one formatter ──
describe("formatPay", () => {
  const now = new Date(`${FX_AS_OF}T12:00:00Z`);
  it.each([
    ["annual INR, shown to a USD reader", { min: 3_000_000, max: 4_500_000, currency: "INR", period: "year" }, { currency: "USD" }, "₹30L–45L / yr (≈ $32k–48k)"],
    ["monthly EUR, same currency, yearly view", { min: 66_000, max: 78_000, currency: "EUR", period: "month" }, { currency: "EUR" }, "€5,500–6,500 / mo (≈ €66k–78k / yr)"],
    ["hourly USD", { min: 104_000, max: 145_600, currency: "USD", period: "hour" }, { currency: "USD" }, "$50–70 / hr (≈ $104k–146k / yr, annualised from hourly)"],
    ["annual INR, monthly view", { min: 3_000_000, max: 4_500_000, currency: "INR", period: "year" }, { currency: "INR", period: "month" }, "₹30L–45L / yr (≈ ₹2.5L–3.75L / mo)"],
    ["annual USD, no conversion asked", { min: 150_000, max: 200_000, currency: "USD" }, {}, "$150k–200k / yr"],
    ["same currency + period: nothing to add", { min: 150_000, max: 200_000, currency: "USD", period: "year" }, { currency: "USD" }, "$150k–200k / yr"],
    ["a cap", { min: null, max: 2_400_000, currency: "INR", period: "year" }, {}, "up to ₹24L / yr"],
    ["a floor", { min: 140_000, max: null, currency: "USD", period: "year" }, {}, "$140k+ / yr"],
    ["OTE + equity", { min: 180_000, max: 220_000, currency: "USD", basis: "ote", equity: true }, {}, "$180k–220k / yr OTE + equity"],
    ["a code-only currency", { min: 120_000, max: 140_000, currency: "CHF" }, {}, "CHF 120k–140k / yr"],
    ["monthly INR stipend", { min: 300_000, max: null, currency: "INR", period: "month" }, {}, "₹25,000+ / mo (≈ ₹3L+ / yr)"],
    ["an unknown display currency is ignored", { min: 150_000, max: 200_000, currency: "USD" }, { currency: "XYZ" }, "$150k–200k / yr"],
  ] as const)("%s", (_l, pay, opts, want) => {
    expect(formatPay(pay, { ...opts, now })!.text).toBe(want);
  });

  it("labels estimates and reports the rate date of a conversion", () => {
    const f = formatPay({ min: 150_000, max: 190_000, currency: "USD" }, { estimate: true, currency: "EUR", now })!;
    expect(f.text).toMatch(/^est\. \$150k–190k \/ yr \(≈ €137k–173k\)$/);
    expect(f.rateDate).toBe(FX_AS_OF);
    expect(formatPay({ min: null, max: null, currency: "USD" })).toBeNull();
  });

  it("the display currency follows the reader: explicit, none, or the home country's", () => {
    expect(resolveDisplayCurrency({ display: { currency: "USD", period: "year" } })).toBe("USD");
    expect(resolveDisplayCurrency({ display: { currency: "none", period: "year" }, homeCountry: "IN" })).toBeNull();
    expect(resolveDisplayCurrency({ display: { currency: "auto", period: "year" }, homeCountry: "IN" })).toBe("INR");
    expect(resolveDisplayCurrency({ homeCountry: "DE" })).toBe("EUR");
    expect(resolveDisplayCurrency({ currency: "GBP" })).toBe("GBP");
    expect(payDisplayOptions({ homeCountry: "GB", display: { currency: "auto", period: "month" } })).toEqual({ currency: "GBP", period: "month" });
  });
});

// ── comparisons in one currency ──
function band(over: Partial<SalaryBand>): SalaryBand {
  return { min: null, max: null, currency: "USD", source: "jd_direct", confidence: "high", ...over };
}

describe("comparisons across currencies and periods", () => {
  const now = new Date(`${FX_AS_OF}T12:00:00Z`);
  it("same currency: the plain ceiling vs the line", () => {
    expect(statedCeilingBelow(band({ min: 50_000, max: 60_000 }), 100_000, "USD", 0.7, { now }).below).toBe(true);
    expect(statedCeilingBelow(band({ min: 50_000, max: 75_000 }), 100_000, "USD", 0.7, { now }).below).toBe(false);
  });
  it("a monthly figure is compared as its year", () => {
    // ₹1L / month = ₹12L / yr < 0.7 × ₹20L
    expect(statedCeilingBelow(band({ min: 960_000, max: 1_200_000, currency: "INR", period: "month" }), 2_000_000, "INR", 0.7, { now }).below).toBe(true);
  });
  it("converted: below only after the FX margin; near the line it is never decided", () => {
    // $12k ≈ ₹11.2L; ₹11.2L × 1.03 < ₹14L
    expect(statedCeilingBelow(band({ min: 10_000, max: 12_000 }), 2_000_000, "INR", 0.7, { now })).toMatchObject({ below: true, converted: true, rateDate: FX_AS_OF });
    // $14.6k ≈ ₹13.64L — under ₹14L at the mid rate, but inside the 3% margin
    expect(statedCeilingBelow(band({ min: 10_000, max: 14_600 }), 2_000_000, "INR", 0.7, { now }).below).toBe(false);
  });
  it("never on an annualised hourly rate, a non-high band, a floor-only band, or an unknown currency", () => {
    expect(statedCeilingBelow(band({ min: 20_800, max: 31_200, period: "hour" }), 100_000, "USD", 0.7, { now }).below).toBe(false);
    expect(statedCeilingBelow(band({ min: 20_000, max: 30_000, confidence: "medium_high" }), 100_000, "USD", 0.7, { now }).below).toBe(false);
    expect(statedCeilingBelow(band({ min: 20_000 }), 100_000, "USD", 0.7, { now }).below).toBe(false);
    expect(statedCeilingBelow(band({ min: 20_000, max: 30_000, currency: "XYZ" }), 100_000, "USD", 0.7, { now }).below).toBe(false);
  });
  it("a converted band is one confidence step lower for soft uses", () => {
    expect(comparablePay(band({ min: 100_000, max: 120_000 }), "USD")).toMatchObject({ confidence: "high", converted: false });
    expect(comparablePay(band({ min: 100_000, max: 120_000 }), "INR")).toMatchObject({ confidence: "medium_high", converted: true });
  });
  it("sort-by-pay ranks every posting in one currency: stated top, else the estimate's median", () => {
    const inr = { salary: band({ min: 3_000_000, max: 4_500_000, currency: "INR" }), salaryEstimate: null };
    const usd = { salary: band({ min: 120_000, max: 150_000 }), salaryEstimate: null };
    const est = {
      salary: band({ source: "none" }),
      salaryEstimate: { min: 80_000, median: 90_000, max: 100_000, currency: "EUR", confidence: "medium" as const, confidenceScore: 0.5, sampleCount: 3, sources: [], basis: "", computedAt: "" },
    };
    const none = { salary: band({ source: "none" }), salaryEstimate: null };
    const order = [inr, usd, est, none].sort((a, b) => (payForSort(b, "USD") ?? -1) - (payForSort(a, "USD") ?? -1));
    expect(order).toEqual([usd, est, inr, none]);
  });
});

describe("the hard floor across currencies (invariant #4)", () => {
  function profile(floor: number, currency: string): Profile {
    return {
      id: "p1", tenantId: "t1", masterResume: "", aboutText: "", profileEmbedding: null, yoe: 3, levelBand: "mid",
      prefs: { salaryFloor: floor, currency, locationWeights: [], stackMustHaves: [], stackProfile: [], remoteGeoOk: ["worldwide"], relocate: true, targetArchetypes: [] },
    } as unknown as Profile;
  }
  function posting(salary: SalaryBand): Posting {
    const now = new Date();
    return {
      id: "j1", companyId: "c1", companyName: "Acme", atsType: "greenhouse", atsJobId: "1", source: "greenhouse", tier: "tier1",
      title: "Backend Engineer", titleNorm: "software-engineer", roleArchetype: "backend", levelBand: "mid", jdText: "", jdSkills: [],
      requirements: [], location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null, confidence: 0.9 },
      salary, experience: { min: null, max: null }, applyUrl: null, jdEmbedding: null, firstSeen: now, lastSeen: now, isActive: true,
      repostCount: 0, canonicalId: null, dedupKey: "k",
    } as unknown as Posting;
  }

  it("a USD band clearly below a ₹ floor is excluded, and the reason names the rate", () => {
    const r = scorePosting(posting(band({ min: 9_000, max: 12_000 })), profile(2_000_000, "INR"));
    expect(r.rulePass).toBe(false);
    expect(r.flags.hardExclusionReason).toMatch(/at \d{4}-\d{2}-\d{2} rates/);
  });
  it("a USD band near the ₹ line (inside the FX margin) is only down-weighted", () => {
    const r = scorePosting(posting(band({ min: 12_000, max: 14_600 })), profile(2_000_000, "INR"));
    expect(r.rulePass).toBe(true);
  });
  it("an hourly rate is never excluded, however low it annualises", () => {
    const r = scorePosting(posting(band({ min: 20_800, max: 31_200, period: "hour" })), profile(150_000, "USD"));
    expect(r.rulePass).toBe(true);
  });
  it("a stated monthly band is compared as its year", () => {
    const low = scorePosting(posting(band({ min: 600_000, max: 840_000, currency: "INR", period: "month" })), profile(2_000_000, "INR"));
    expect(low.rulePass).toBe(false); // ₹8.4L/yr < 0.7 × ₹20L
    const ok = scorePosting(posting(band({ min: 1_800_000, max: 2_400_000, currency: "INR", period: "month" })), profile(2_000_000, "INR"));
    expect(ok.rulePass).toBe(true);
  });
});

describe("describePay — what a card shows (feed review 2026-11)", () => {
  const now = new Date(`${FX_AS_OF}T12:00:00Z`);
  const loc = (raw: string, jd = "") => parseLocation(raw, jd);
  const est = (min: number, max: number, confidenceScore: number, currency = "INR") => ({
    min, median: Math.sqrt(min * max), max, currency, confidence: "low" as const, confidenceScore, sampleCount: 4,
    sources: [{ source: "corpus", median: 1, weight: 1, detail: "" }], basis: "4 similar", computedAt: "",
  });
  const none = band({ source: "none" });

  it("a low-confidence estimate is one rough figure, never a wide precise-looking band", () => {
    const v = describePay({ salary: none, salaryEstimate: est(1_090_000, 2_740_000, 0.33), location: loc("Bengaluru, India") }, { now })!;
    expect(v).toMatchObject({ estimate: true, rough: true });
    expect(v.label).toBe("rough est. ~₹17L / yr");
    // wide even at higher confidence → rough too
    expect(describePay({ salary: none, salaryEstimate: est(42_000, 137_000, 0.6, "USD"), location: loc("Remote") })!.rough).toBe(true);
    // a confident, tight estimate keeps its band, still marked "est."
    expect(describePay({ salary: none, salaryEstimate: est(150_000, 190_000, 0.7, "USD"), location: loc("Austin, TX") })!.label).toBe("est. $150k–190k / yr");
  });

  it("min = max prints one value", () => {
    expect(describePay({ salary: band({ min: 4_410_000, max: 4_410_000, currency: "INR" }), salaryEstimate: null, location: loc("Pune, India") })!.label).toBe("₹44.1L / yr");
    expect(describePay({ salary: band({ min: 220_000, max: 220_000 }), salaryEstimate: null, location: loc("Austin, TX") })!.label).toBe("$220k / yr");
  });

  it("keeps a stated band whose currency disagrees with the location, and flags it", () => {
    const v = describePay({ salary: band({ min: 600_000, max: 1_500_000, currency: "INR" }), salaryEstimate: null, location: loc("Remote", "Remote — US only") })!;
    expect(v.label).toBe("₹6L–15L / yr");
    expect(v.warning).toBe("Pay is stated in INR for a US-only remote role — check the posting");
    // USD travels: never a disagreement; nor a matching currency
    expect(currencyMismatch({ salary: band({ min: 50_000, max: 60_000 }), location: loc("Bengaluru, India") })).toBeNull();
    expect(currencyMismatch({ salary: band({ min: 50_000, max: 60_000, currency: "EUR" }), location: loc("Berlin, Germany") })).toBeNull();
    expect(currencyMismatch({ salary: band({ min: 50_000, max: 60_000, currency: "GBP" }), location: loc("Berlin, Germany") })).toMatch(/GBP for a role in Germany/);
  });

  it("formats in the reader's display currency and period", () => {
    const v = describePay({ salary: band({ min: 66_000, max: 78_000, currency: "EUR", period: "month" }), salaryEstimate: null, location: loc("Berlin, Germany") }, { currency: "USD", now })!;
    expect(v.label).toBe("€5,500–6,500 / mo (≈ $72k–86k / yr)");
    expect(v.rateDate).toBe(FX_AS_OF);
    expect(formatAmount(4_000_000, "INR")).toBe("₹40L / yr");
    expect(formatAmount(60_000, "EUR", "month")).toBe("€5,000 / mo");
  });
});
