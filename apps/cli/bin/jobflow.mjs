#!/usr/bin/env node
// `jobflow` launcher: runs the TypeScript entry through tsx — no build step. Works from
// the repo root (`pnpm jobflow …`), after `pnpm link --global` in apps/cli, or after
// `npm i -g ./apps/cli` (both link this checkout, so `git pull` updates the command).
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/main.ts", import.meta.url).href);
