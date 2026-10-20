import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const LOCK_NAME = "route.lock";

export function newJobId(now = Date.now(), pid = process.pid, hex = randomBytes(2).toString("hex")) {
  return `${Number(now).toString(36)}-${pid}-${hex}`;
}

export function isActiveState(state) {
  if (!state || state === "queued" || state === "done") return false;
  return !String(state).startsWith("failed");
}

export function liveLeases(leases, isAlive) {
  return (leases || []).filter((lease) => lease && isAlive(lease.pid));
}

export function admit(leases, cap, jobId) {
  const active = (leases || []).filter((lease) => isActiveState(lease.state));
  const queued = (leases || [])
    .filter((lease) => lease.state === "queued")
    .sort((a, b) => a.createdAt - b.createdAt || String(a.jobId).localeCompare(String(b.jobId)));
  if (!queued.length || queued[0].jobId !== jobId) {
    return { admitted: false, reason: queued.length ? "not-oldest" : "missing" };
  }
  if (active.length >= cap) return { admitted: false, reason: "at-cap" };
  return { admitted: true };
}

export function shouldDisconnect(leases, isAlive = () => true) {
  return liveLeases(leases, isAlive).length === 0;
}

export function routeFresh(route, now, maxAgeMs = 30000) {
  if (!route || route.state !== "connected" || !Number.isFinite(Number(route.verifiedAt))) return false;
  return now - Number(route.verifiedAt) < maxAgeMs;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function withRouteLock(root, fn, options = {}) {
  const staleMs = options.staleMs ?? 90_000;
  const waitMs = options.waitMs ?? 250;
  const isAlive = options.isAlive ?? defaultAlive;
  const lockPath = path.join(root, LOCK_NAME);
  fs.mkdirSync(root, { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const current = readJson(lockPath);
      const stale = !current || !isAlive(current.pid) || Date.now() - Number(current.at) > staleMs;
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another waiter already removed the stale lock.
        }
        continue;
      }
      await sleep(waitMs);
    }
  }
  const heartbeat = setInterval(() => {
    try {
      const current = readJson(lockPath);
      if (current?.pid === process.pid) {
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
      }
    } catch {
      // The lock is released or unreadable.
    }
  }, 5000);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      const current = readJson(lockPath);
      if (current?.pid === process.pid) fs.unlinkSync(lockPath);
    } catch {
      // The lock is already gone.
    }
  }
}
