import { describe, expect, it, vi } from "vitest";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { runGate } from "./service/timer.js";

/* ------------------------------------------------------------------ */
/*  Unit tests for runGate()                                          */
/* ------------------------------------------------------------------ */

describe("runGate", () => {
  it("passes when command exits 0", async () => {
    const result = await runGate("exit 0");
    expect(result).toEqual({ pass: true });
  });

  it("fails when command exits non-zero", async () => {
    const result = await runGate("exit 1");
    expect(result.pass).toBe(false);
  });

  it("includes stderr in reason on failure", async () => {
    const result = await runGate("echo 'no issues found' >&2; exit 1");
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain("no issues found");
    }
  });

  it("includes stdout in reason when stderr is empty", async () => {
    const result = await runGate("echo 'nothing to do'; exit 1");
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain("nothing to do");
    }
  });

  it("times out and fails for slow commands", async () => {
    const result = await runGate("sleep 60", 200);
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain("timed out");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Integration tests: gate + cron service                            */
/* ------------------------------------------------------------------ */

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

/** Create a barrier that resolves on any finished event (ok, skipped, error). */
function createAnyFinishedBarrier() {
  const resolvers = new Map<string, (evt: CronEvent) => void>();
  return {
    waitFor: (jobId: string) =>
      new Promise<CronEvent>((resolve) => {
        resolvers.set(jobId, resolve);
      }),
    onEvent: (evt: CronEvent) => {
      if (evt.action !== "finished") {
        return;
      }
      const resolve = resolvers.get(evt.jobId);
      if (!resolve) {
        return;
      }
      resolvers.delete(evt.jobId);
      resolve(evt);
    },
  };
}

describe("cron gate integration", () => {
  it("runs job normally when gate exits 0", async () => {
    const store = await makeStorePath();
    const barrier = createAnyFinishedBarrier();
    const enqueueSystemEvent = vi.fn();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: barrier.onEvent,
    });

    await cron.start();
    const job = await cron.add({
      name: "gate-pass",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
      gate: "exit 0",
    });

    const dueAt = job.state.nextRunAtMs!;
    vi.setSystemTime(new Date(dueAt + 5));
    await vi.runOnlyPendingTimersAsync();

    const evt = await barrier.waitFor(job.id);
    expect(evt.status).toBe("ok");
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello", expect.anything());

    cron.stop();
    await store.cleanup();
  });

  it("skips job when gate exits non-zero", async () => {
    const store = await makeStorePath();
    const barrier = createAnyFinishedBarrier();
    const enqueueSystemEvent = vi.fn();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: barrier.onEvent,
    });

    await cron.start();
    const job = await cron.add({
      name: "gate-fail",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "should not run" },
      gate: "exit 1",
    });

    const dueAt = job.state.nextRunAtMs!;
    vi.setSystemTime(new Date(dueAt + 5));
    await vi.runOnlyPendingTimersAsync();

    const evt = await barrier.waitFor(job.id);
    expect(evt.status).toBe("skipped");
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("runs job normally when no gate is set", async () => {
    const store = await makeStorePath();
    const barrier = createAnyFinishedBarrier();
    const enqueueSystemEvent = vi.fn();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: barrier.onEvent,
    });

    await cron.start();
    const job = await cron.add({
      name: "no-gate",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });

    const dueAt = job.state.nextRunAtMs!;
    vi.setSystemTime(new Date(dueAt + 5));
    await vi.runOnlyPendingTimersAsync();

    const evt = await barrier.waitFor(job.id);
    expect(evt.status).toBe("ok");
    expect(enqueueSystemEvent).toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });
});
