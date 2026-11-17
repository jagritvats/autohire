import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRootEnv, parseDotEnv } from "../src/env.js";

describe("parseDotEnv", () => {
  it("parses the repo's .env.example (inline comments stripped, empties kept)", () => {
    const env = parseDotEnv(readFileSync(join(__dirname, "fixtures", "env.example"), "utf8"));
    expect(env.JOBFLOW_POLL_EVERY_HOURS).toBe("6");
    expect(Number(env.JOBFLOW_POLL_EVERY_HOURS)).toBe(6);
    expect(env.JOBFLOW_LIVENESS_EVERY_HOURS).toBe("2");
    expect(env.JOBFLOW_RERANK_TOP).toBe("15");
    expect(env.JOBFLOW_POLL_COUNTRY).toBe("IN");
    expect(env.JOBFLOW_BROWSER).toBe("off");
    expect(env.JOBFLOW_AUTOSUBMIT).toBe("false");
    expect(env.JSEARCH_MIN_HOURS).toBe("24");
    expect(env.JOBFLOW_LOCAL_POLL_EVERY_HOURS).toBe("12");
    expect(env.TENANT_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(env.DATABASE_URL).toBe("postgresql://postgres:postgres@localhost:5432/jobflow");
    expect(env.LLM_PROVIDER).toBe("echo");
    // empty values — including one followed only by a comment — are "", not the comment
    expect(env.SUPABASE_URL).toBe("");
    expect(env.CAREERJET_USER_IP).toBe("");
    expect(env.JOBFLOW_TIER3_SOURCES).toBe("");
    expect(env.JOBFLOW_TIER3_MIN_LPA).toBe("");
    // a commented-out assignment is not set at all
    expect("JOBFLOW_TELEGRAM_CHANNELS" in env).toBe(false);
    for (const v of Object.values(env)) expect(v).not.toMatch(/\s#/);
  });

  it("handles quotes, escapes, export, comments and CRLF", () => {
    const text = [
      "# comment",
      "export A=1",
      "B = two words  # trailing",
      "C='single # not a comment'  # but this is",
      'D="line1\\nline2 \\"q\\" \\\\ # kept"',
      "E=pa#ss",
      "F=",
      "G=#only-comment",
      'H="multi',
      'line"',
      "I='literal \\n'",
      "not a line",
      "=nokey",
      "J=x=y",
      'K="unterminated',
      "L=\tpadded\t",
    ].join("\r\n");
    expect(parseDotEnv(text)).toEqual({
      A: "1",
      B: "two words",
      C: "single # not a comment",
      D: 'line1\nline2 "q" \\ # kept',
      E: "pa#ss",
      F: "",
      G: "",
      H: "multi\nline",
      I: "literal \\n",
      J: "x=y",
      K: '"unterminated',
      L: "padded",
    });
  });

  it("strips a BOM and lets a later duplicate win", () => {
    expect(parseDotEnv("﻿X=1\nX=2")).toEqual({ X: "2" });
  });
});

describe("loadRootEnv", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("loads the workspace .env then $JOBFLOW_DATA_DIR/.env without overriding set vars", () => {
    const root = mkdtempSync(join(tmpdir(), "jobflow-env-"));
    dirs.push(root);
    const data = join(root, "data");
    mkdirSync(join(root, "apps", "x"), { recursive: true });
    mkdirSync(data);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, ".env"), `A=root   # c\nB=root\nJOBFLOW_DATA_DIR=${data}\n`);
    writeFileSync(join(data, ".env"), "B=data\nC=data\n");
    const env: Record<string, string | undefined> = { A: "shell" };
    const loaded = loadRootEnv(join(root, "apps", "x"), env);
    expect(loaded).toEqual([join(root, ".env"), join(data, ".env")]);
    expect(env).toMatchObject({ A: "shell", B: "root", C: "data", JOBFLOW_DATA_DIR: data });
  });
});
