import { describe, expect, it } from "vitest";
import { pgConnectionConfig, sslFromMode } from "../src/sql.js";

describe("Postgres TLS from sslmode", () => {
  it("maps libpq modes", () => {
    expect(sslFromMode(undefined)).toBe(false);
    expect(sslFromMode("disable")).toBe(false);
    expect(sslFromMode("prefer")).toBe(false);
    expect(sslFromMode("require")).toEqual({ rejectUnauthorized: false });
    expect(sslFromMode("no-verify")).toEqual({ rejectUnauthorized: false });
    expect(sslFromMode("verify-ca")).toEqual({ rejectUnauthorized: true });
    expect(sslFromMode("VERIFY-FULL")).toEqual({ rejectUnauthorized: true });
  });

  it("reads sslmode from the URL (stripping it so pg can't override), else PGSSLMODE; never sniffs the host", () => {
    const a = pgConnectionConfig("postgresql://u:p@db.example.supabase.co:5432/postgres?sslmode=require&application_name=jf", {});
    expect(a.ssl).toEqual({ rejectUnauthorized: false });
    expect(a.connectionString).toBe("postgresql://u:p@db.example.supabase.co:5432/postgres?application_name=jf");

    expect(pgConnectionConfig("postgresql://u:p@db.example.supabase.co/postgres", {}).ssl).toBe(false);
    expect(pgConnectionConfig("postgresql://u:p@host/db", { PGSSLMODE: "verify-full" }).ssl).toEqual({ rejectUnauthorized: true });
    // the URL beats the environment
    expect(pgConnectionConfig("postgresql://u:p@host/db?sslmode=disable", { PGSSLMODE: "require" }).ssl).toBe(false);
  });
});
