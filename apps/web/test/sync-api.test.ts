import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { startCorpusSync, type SyncRunner } from "@jobflow/service";
import type { PollListener } from "@jobflow/pipeline";
import { deleteSync, getSync, postSync, syncStream } from "../lib/syncApi";

/**
 * The sync API (what /api/sync and /api/sync/stream run, with the caller from guard()):
 * status, start (admin only, returns at once), cancel, and the SSE stream — each scoped to
 * the CALLER's tenant (invariant #7). The poll is a fake: no network.
 */

const admin = { tenantId: "tenant-a", role: "admin" };
const member = { tenantId: "tenant-b", role: "member" };

/** a fake sync that reports what the test tells it to, until released or cancelled */
function controllableRun() {
  let emit: PollListener = () => {};
  let release = () => {};
  const runner: SyncRunner = async (_repo, hooks) => {
    emit = hooks.onProgress;
    await new Promise<void>((resolve) => {
      release = resolve;
      hooks.signal.addEventListener("abort", () => resolve());
    });
  };
  return { runner, emit: (e: Parameters<PollListener>[0]) => emit(e), release: () => release() };
}

/** read SSE frames until `until` matches one (or the time runs out) */
async function readFrames(res: Response, until: (frames: Array<{ event: string; data: any }>) => boolean, ms = 3000) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Array<{ event: string; data: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !until(frames)) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
    if (!chunk || chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (event && data) frames.push({ event, data: JSON.parse(data) });
    }
  }
  reader.releaseLock();
  return frames;
}

describe("sync API", () => {
  it("status: idle, never synced, and whether the caller may sync", async () => {
    const repo = new InMemoryRepository();
    const a = await (await getSync(repo, admin)).json();
    expect(a).toMatchObject({ current: null, last: null, lastSyncAt: null, canSync: true });
    const b = await (await getSync(repo, member)).json();
    expect(b.canSync).toBe(false);
  });

  it("start is an admin action that returns at once; cancel stops the run and it lands in history", async () => {
    const repo = new InMemoryRepository();
    expect((await postSync(repo, member)).status).toBe(403);
    expect((await deleteSync(repo, member)).status).toBe(403);

    const fake = controllableRun();
    const run = startCorpusSync(repo, undefined, fake.runner, { trigger: "scheduled" });
    // POST joins the running sync instead of starting a second one, and doesn't wait for it
    const started = await postSync(repo, admin);
    expect(started.status).toBe(202);
    const body = await started.json();
    expect(body.status.current).toMatchObject({ status: "running", trigger: "scheduled" });

    const cancelled = await deleteSync(repo, admin);
    expect(cancelled.status).toBe(202);
    expect((await cancelled.json()).status.current.cancelRequested).toBe(true);
    await run;
    expect((await deleteSync(repo, admin)).status).toBe(409); // nothing left to cancel

    const after = await (await getSync(repo, admin)).json();
    expect(after.current).toBeNull();
    expect(after.last).toMatchObject({ status: "cancelled" });
    expect(after.history).toHaveLength(1);
  });

  it("the stream sends the caller's view: status on connect, live progress, status when it ends", async () => {
    const repo = new InMemoryRepository();
    const fake = controllableRun();
    const run = startCorpusSync(repo, undefined, fake.runner);
    const ac = new AbortController();
    const res = syncStream(repo, member, ac.signal, { throttleMs: 0, clockMs: 60_000 });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    let frames = await readFrames(res, (f) => f.some((x) => x.event === "status"));
    expect(frames[0]?.event).toBe("status");
    expect(frames[0]?.data.current.status).toBe("running");

    fake.emit({ type: "phase", phase: "boards", state: "start" });
    fake.emit({ type: "plan", boards: 2, deferred: 0, notDue: 0, budgetMs: null, concurrency: 1 });
    fake.emit({ type: "board", state: "start", id: "1", name: "Example Co" });
    // another tenant's private source must never reach this caller
    fake.emit({ type: "source", state: "start", key: "custom:x", label: "private.example.org", kind: "custom", tenantIds: ["tenant-a"] });
    frames = await readFrames(res, (f) => f.some((x) => x.event === "progress" && x.data.boards.inFlight.includes("Example Co")));
    const progress = frames.filter((f) => f.event === "progress").at(-1)!;
    expect(progress.data.phase).toBe("boards");
    expect(progress.data.boards.total).toBe(2);
    expect(JSON.stringify(frames)).not.toContain("private.example.org");

    fake.release();
    await run;
    frames = await readFrames(res, (f) => f.some((x) => x.event === "status" && x.data.current === null));
    const end = frames.find((f) => f.event === "status" && f.data.current === null)!;
    expect(end.data.last.status).toBe("done");
    ac.abort();
  });
});
