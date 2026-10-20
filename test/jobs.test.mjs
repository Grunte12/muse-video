import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  admit,
  liveLeases,
  newJobId,
  routeFresh,
  shouldDisconnect,
  withRouteLock,
  writeJsonAtomic,
  readJson,
} from "../lib/jobs.mjs";

test("job ids are time, pid, and four hex characters", () => {
  assert.equal(newJobId(36, 7, "ab12"), "10-7-ab12");
});

test("live leases drop dead pids", () => {
  const leases = [
    { jobId: "alive", pid: 1, state: "generating" },
    { jobId: "dead", pid: 2, state: "generating" },
  ];
  const live = liveLeases(leases, (pid) => pid === 1);
  assert.deepEqual(live.map((lease) => lease.jobId), ["alive"]);
});

test("admission is FIFO and stops at the cap", () => {
  const queued = [
    { jobId: "b", pid: 2, state: "queued", createdAt: 20 },
    { jobId: "a", pid: 1, state: "queued", createdAt: 10 },
  ];
  assert.equal(admit(queued, 1, "b").reason, "not-oldest");
  assert.equal(admit(queued, 1, "a").admitted, true);

  const busy = [
    { jobId: "run", pid: 3, state: "generating", createdAt: 1 },
    { jobId: "a", pid: 1, state: "queued", createdAt: 10 },
  ];
  assert.equal(admit(busy, 1, "a").reason, "at-cap");
  assert.equal(admit(busy, 2, "a").admitted, true);
});

test("a dead active lease does not block the oldest queued job", () => {
  const all = [
    { jobId: "dead", pid: 5, state: "generating", createdAt: 1 },
    { jobId: "a", pid: 6, state: "queued", createdAt: 2 },
  ];
  const live = liveLeases(all, (pid) => pid === 6);
  assert.equal(admit(live, 1, "a").admitted, true);
});

test("disconnect only when every live lease is gone", () => {
  const isAlive = (pid) => pid === 1;
  assert.equal(shouldDisconnect([{ pid: 1, state: "queued" }], isAlive), false);
  assert.equal(shouldDisconnect([{ pid: 1, state: "generating" }], isAlive), false);
  assert.equal(shouldDisconnect([{ pid: 2, state: "generating" }], isAlive), true);
  assert.equal(shouldDisconnect([], isAlive), true);
});

test("a connected route is fresh for 30 seconds", () => {
  assert.equal(routeFresh({ state: "connected", verifiedAt: 1000 }, 2000), true);
  assert.equal(routeFresh({ state: "connected", verifiedAt: 1000 }, 40_000), false);
  assert.equal(routeFresh({ state: "off", verifiedAt: 1000 }, 2000), false);
  assert.equal(routeFresh(null, 2000), false);
});

test("atomic writes replace the whole file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-jobs-"));
  const file = path.join(root, "jobs", "one.json");
  writeJsonAtomic(file, { jobId: "one", state: "queued" });
  assert.deepEqual(readJson(file), { jobId: "one", state: "queued" });
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
});

test("the route lock is exclusive and a stale lock is replaced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-jobs-"));
  let inside = 0;
  let max = 0;
  await Promise.all(
    [0, 1].map(() =>
      withRouteLock(root, async () => {
        inside += 1;
        max = Math.max(max, inside);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inside -= 1;
      }),
    ),
  );
  assert.equal(max, 1);

  fs.writeFileSync(path.join(root, "route.lock"), JSON.stringify({ pid: 99999999, at: Date.now() }));
  let ran = false;
  await withRouteLock(root, async () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.equal(fs.existsSync(path.join(root, "route.lock")), false);
});
