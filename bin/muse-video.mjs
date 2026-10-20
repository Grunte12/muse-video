#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  debugHost,
  countLiteral,
  explainPick,
  extractReply,
  parseChromeCommand,
  parseTrace,
  pickMuseTarget,
  sameProfile,
  vpnGate,
} from "../lib/gates.mjs";
import { chromeDir, debugPort, stateDir } from "../lib/home.mjs";
import {
  admit,
  liveLeases,
  newJobId,
  readJson,
  routeFresh,
  shouldDisconnect,
  withRouteLock,
  writeJsonAtomic,
} from "../lib/jobs.mjs";

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const VPN_ID = "eppiocemhmnlbhjplcgkofciiegomcon";
const VPN_STORE = `https://chromewebstore.google.com/detail/urban-vpn-proxy/${VPN_ID}`;
const HELP = `muse-video — one pipeline for a Muse video

send starts the separate Chrome on a blank page, connects the VPN extension,
and opens Muse only after the exit country differs from this Mac.
Every agent shares one queue. Jobs run one at a time on one Muse tab.
The VPN stays on while the queue has work. When the queue is empty, the Muse
page closes and the VPN disconnects.
status and latest only look. They do not open Muse. The main Chrome is never used.

  muse-video send --prompt TEXT [--mode text-to-video|frame-to-video|reference-to-video]
            [--first-frame FILE] [--last-frame FILE] [--reference FILE ...]
            [--wait 180] [--queue-wait 600] [--download] [--out DIR] [--json]
  muse-video status [--json]
  muse-video latest [--job ID] [--json]
  muse-video jobs [--job ID] [--limit N] [--json]       saved log of past jobs
  muse-video collect [--job ID] [--out DIR] [--json]    download the newest clip from an open Muse tab,
                                                        skipping clips saved before

Exit codes: 0 mp4 saved, 2 usage, 3 VPN route refused, 4 no mp4, 5 send failed, 6 queue timeout.
`;

const SNAPSHOT_EXPR = `(() => {
  const ta = document.querySelector('textarea[aria-label="Message"]');
  const scroller = [...document.querySelectorAll('div')].find((el) => {
    const cls = String(el.className || '');
    return cls.includes('scrollbar-hide') && el.scrollHeight > el.clientHeight + 40;
  });
  const text = scroller ? scroller.innerText : '';
  const videos = scroller ? [...scroller.querySelectorAll('video')].map((node) => node.currentSrc || node.src).filter(Boolean) : [];
  const openers = scroller ? [...scroller.querySelectorAll('[aria-label^="Open animated video"]')].map((node) => node.getAttribute('aria-label')) : [];
  const images = scroller ? [...scroller.querySelectorAll('img')].filter((img) => (img.naturalWidth || img.width) >= 200).map((img) => img.currentSrc || img.src).filter(Boolean) : [];
  const taRect = ta ? ta.getBoundingClientRect() : null;
  const stopNear = taRect ? [...document.querySelectorAll('button[aria-label="Stop"]')].some((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const buttonMid = (rect.top + rect.bottom) / 2;
    const inputMid = (taRect.top + taRect.bottom) / 2;
    return Math.abs(buttonMid - inputMid) < 80;
  }) : false;
  const taskStop = [...document.querySelectorAll('[aria-label="Stop task"]')].some((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return {
    href: location.href,
    title: document.title,
    composer: Boolean(ta),
    composerEmpty: ta ? ta.value.trim() === '' : false,
    text,
    userCount: (text.match(/User message:/g) || []).length,
    assistantCount: (text.match(/Assistant message:/g) || []).length,
    videos,
    openers,
    images,
    stopNear,
    taskStop,
  };
})()`;

function parseArgs(argv) {
  const out = {
    _: [],
    json: false,
    download: false,
    wait: 300,
    queueWait: 600,
    country: process.env.MUSE_TAB_COUNTRY || "",
    job: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--download") out.download = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--wait") out.wait = Number(argv[++i]);
    else if (arg === "--queue-wait") out.queueWait = Number(argv[++i]);
    else if (arg === "--job") out.job = argv[++i] || "";
    else if (arg === "--limit") out.limit = argv[++i];
    else if (arg === "--country") out.country = argv[++i] || "";
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--prompt") out.prompt = argv[++i];
    else if (arg === "--prompt-file") out.promptFile = argv[++i];
    else if (arg === "--mode") out.mode = argv[++i];
    else if (arg === "--first-frame") out.firstFrame = argv[++i];
    else if (arg === "--last-frame") out.lastFrame = argv[++i];
    else if (arg === "--reference") {
      out.references ||= [];
      out.references.push(argv[++i]);
    }
    else if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag ${arg}`);
    } else out._.push(arg);
  }
  return out;
}

function discoverChromes() {
  const output = execFileSync("ps", ["-ax", "-o", "command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const found = [];
  const seen = new Set();
  for (const line of output.split("\n")) {
    const chrome = parseChromeCommand(line);
    if (!chrome) continue;
    const key = `${chrome.addr}:${chrome.port}:${chrome.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(chrome);
  }
  return found;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`Could not connect to ${wsUrl}`)), { once: true });
  });
  const events = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method && events.has(message.method)) {
      for (const handler of events.get(message.method)) handler(message.params || {});
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || "CDP error"));
    else resolve(message.result ?? {});
  });
  return {
    ready,
    on(method, handler) {
      if (!events.has(method)) events.set(method, []);
      events.get(method).push(handler);
    },
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function fetchJson(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return await response.json();
    } catch (error) {
      const cause = error.cause?.code || error.cause?.message || error.message;
      last = new Error(`Could not reach ${url} (${cause})`);
      if (attempt < 2) await sleep(400);
    }
  }
  throw last;
}

function ownChrome() {
  return discoverChromes().find((chrome) => sameProfile(chrome.dir, chromeDir) && debugHost(chrome.addr)) || null;
}

async function readChrome(chrome) {
  const host = debugHost(chrome.addr);
  const version = await fetchJson(`http://${host}:${chrome.port}/json/version`);
  const browser = connect(version.webSocketDebuggerUrl);
  try {
    await browser.ready;
    const [targets, contexts] = await Promise.all([
      browser.send("Target.getTargets"),
      browser.send("Target.getBrowserContexts"),
    ]);
    const pages = (targets.targetInfos || []).filter((target) => target.type === "page");
    return {
      chrome: { ...chrome, host },
      picked: pickMuseTarget(pages, contexts.defaultBrowserContextId),
    };
  } finally {
    browser.close();
  }
}

async function findTab() {
  const running = ownChrome();
  if (!running) {
    return {
      chrome: null,
      target: null,
      notes: ["Muse Chrome is not running. Start the separate window with: muse-video chrome"],
    };
  }
  try {
    const report = await readChrome(running);
    if (report.picked.ok) return { chrome: report.chrome, target: report.picked.target, notes: [] };
    if (report.picked.code === "incognito-only") {
      return {
        chrome: report.chrome,
        target: null,
        notes: ["Muse is only open in incognito. The VPN extension does not run there. Use the normal Muse tab in Muse Chrome."],
      };
    }
    return { chrome: report.chrome, target: null, notes: [explainPick(report.picked.code)] };
  } catch (error) {
    return { chrome: { ...running, host: debugHost(running.addr) }, target: null, notes: [`Could not inspect Muse Chrome: ${error.message}`] };
  }
}

async function ensureChrome() {
  if (ownChrome()) return { started: false };
  const foreign = discoverChromes().find((chrome) => chrome.port === debugPort);
  if (foreign) throw new Error(`Port ${debugPort} is already used by another program.`);
  fs.mkdirSync(chromeDir, { recursive: true });
  const urls = vpnInstalled() ? ["about:blank"] : ["about:blank", VPN_STORE];
  const child = spawn(
    "open",
    [
      "-na",
      "Google Chrome",
      "--args",
      `--user-data-dir=${chromeDir}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...urls,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const running = ownChrome();
    if (running) {
      try {
        await fetchJson(`http://${debugHost(running.addr)}:${running.port}/json/version`);
        return { started: true };
      } catch {
        // The process can appear before the debugging port accepts connections.
      }
    }
    await sleep(250);
  }
  throw new Error("Muse Chrome did not open its local debugging port.");
}

function vpnInstalled() {
  return fs.existsSync(path.join(chromeDir, "Default", "Extensions", VPN_ID));
}

async function withBrowser(chrome, fn) {
  const version = await fetchJson(`http://${chrome.host}:${chrome.port}/json/version`);
  const browser = connect(version.webSocketDebuggerUrl);
  try {
    await browser.ready;
    return await fn(browser);
  } finally {
    browser.close();
  }
}

async function wakeVpn(chrome) {
  const popupUrl = `chrome-extension://${VPN_ID}/popup/index.html`;
  const created = await withBrowser(chrome, (browser) => browser.send("Target.createTarget", { url: popupUrl }));
  const targetId = created.targetId;
  try {
    const list = await fetchJson(`http://${chrome.host}:${chrome.port}/json/list`);
    const page = list.find((target) => target.id === targetId);
    if (!page?.webSocketDebuggerUrl) return false;
    const cdp = connect(page.webSocketDebuggerUrl);
    try {
      await cdp.ready;
      await cdp.send("Runtime.enable");
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const text = String(await evaluate(cdp, "document.body ? document.body.innerText : ''"));
        if (vpnIsConnected(text)) return true;
        const status = text.split("\n").map((line) => line.trim()).find((line) => /connect/i.test(line)) || "";
        if (status === "Not connected") await evaluate(cdp, CLICK_BIG_BUTTON);
        await sleep(700);
      }
      return false;
    } finally {
      cdp.close();
    }
  } finally {
    await withBrowser(chrome, (browser) => browser.send("Target.closeTarget", { targetId })).catch(() => {});
  }
}

function vpnIsConnected(text) {
  return String(text)
    .split("\n")
    .some((line) => line.trim() === "Connected");
}

const CLICK_BIG_BUTTON = `(() => {
  const button = [...document.querySelectorAll('button')].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 70 && rect.height > 70;
  });
  if (button) button.click();
})()`;

async function probeCountry(chrome) {
  const created = await withBrowser(chrome, (browser) => browser.send("Target.createTarget", { url: TRACE_URL }));
  const targetId = created.targetId;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(300);
      const list = await fetchJson(`http://${chrome.host}:${chrome.port}/json/list`);
      const page = list.find((target) => target.id === targetId);
      if (!page?.webSocketDebuggerUrl) continue;
      const cdp = connect(page.webSocketDebuggerUrl);
      try {
        await cdp.ready;
        await cdp.send("Runtime.enable");
        const text = await evaluate(cdp, "document.body ? document.body.innerText : ''");
        const parsed = parseTrace(text);
        if (parsed.loc) return parsed;
      } catch {
        // The probe page is still loading.
      } finally {
        cdp.close();
      }
    }
    return null;
  } finally {
    await withBrowser(chrome, (browser) => browser.send("Target.closeTarget", { targetId })).catch(() => {});
  }
}

async function machineCountry() {
  const urls = [
    "https://www.cloudflare.com/cdn-cgi/trace",
    "https://1.1.1.1/cdn-cgi/trace",
    "https://cloudflare.com/cdn-cgi/trace",
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const parsed = parseTrace(await response.text());
      if (parsed.loc) {
        const saved = { loc: parsed.loc, ip: parsed.ip, at: Date.now() };
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, "machine-country.json"), JSON.stringify(saved));
        return { loc: saved.loc, ip: saved.ip };
      }
    } catch (error) {
      errors.push(error.cause?.code || error.message);
    }
  }
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(stateDir, "machine-country.json"), "utf8"));
    if (cached.loc && Date.now() - cached.at < 10 * 60 * 1000) return { loc: cached.loc, ip: cached.ip || "" };
  } catch {
    // No recent country is saved.
  }
  throw new Error(`Could not read this Mac's exit country (${errors.join(", ")}).`);
}

async function closeMuseTabs(chrome, keepIds = []) {
  const keep = new Set(keepIds.filter(Boolean));
  const list = await fetchJson(`http://${chrome.host}:${chrome.port}/json/list`);
  const tabs = list.filter((target) => {
    if (keep.has(target.id)) return false;
    if (target.type !== "page" || !target.url) return false;
    try {
      const host = new URL(target.url).hostname;
      return host === "muse.ai" || host === "www.muse.ai";
    } catch {
      return false;
    }
  });
  if (!tabs.length) return;
  await withBrowser(chrome, async (browser) => {
    for (const target of tabs) await browser.send("Target.closeTarget", { targetId: target.id });
  });
}

async function closeTab(chrome, targetId) {
  if (!chrome || !targetId) return;
  await withBrowser(chrome, (browser) => browser.send("Target.closeTarget", { targetId }));
}

async function createMuseTab(chrome) {
  const created = await withBrowser(chrome, (browser) => browser.send("Target.createTarget", { url: "https://muse.ai/" }));
  return created.targetId;
}

async function disconnectVpn(chrome) {
  if (!vpnInstalled()) return;
  const created = await withBrowser(chrome, (browser) =>
    browser.send("Target.createTarget", { url: `chrome-extension://${VPN_ID}/popup/index.html` }),
  );
  const targetId = created.targetId;
  try {
    await sleep(800);
    const list = await fetchJson(`http://${chrome.host}:${chrome.port}/json/list`);
    const page = list.find((target) => target.id === targetId);
    if (!page?.webSocketDebuggerUrl) return;
    const cdp = connect(page.webSocketDebuggerUrl);
    try {
      await cdp.ready;
      await cdp.send("Runtime.enable");
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const text = await evaluate(cdp, "document.body ? document.body.innerText : ''");
        if (!vpnIsConnected(text)) return;
        await evaluate(cdp, CLICK_BIG_BUTTON);
        await sleep(800);
      }
    } finally {
      cdp.close();
    }
  } finally {
    await withBrowser(chrome, (browser) => browser.send("Target.closeTarget", { targetId })).catch(() => {});
  }
}

function pidAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function routeFile() {
  return path.join(stateDir, "route.json");
}

function readRoute() {
  return readJson(routeFile());
}

function writeRoute(route) {
  writeJsonAtomic(routeFile(), route);
}

function leaseFile(jobId) {
  return path.join(stateDir, "jobs", `${jobId}.json`);
}

function readLeases() {
  const dir = path.join(stateDir, "jobs");
  if (!fs.existsSync(dir)) return [];
  const leases = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const lease = readJson(path.join(dir, name));
    if (lease?.jobId) leases.push(lease);
  }
  return leases;
}

function saveLease(lease) {
  lease.updatedAt = Date.now();
  writeJsonAtomic(leaseFile(lease.jobId), lease);
}

function removeLease(jobId) {
  fs.rmSync(leaseFile(jobId), { force: true });
}

function queueView() {
  return liveLeases(readLeases(), pidAlive).map((lease) => ({
    jobId: lease.jobId,
    pid: lease.pid,
    state: lease.state,
    prompt: lease.prompt || "",
  }));
}

async function dropStaleLeases(chrome) {
  for (const lease of readLeases()) {
    if (pidAlive(lease.pid)) continue;
    if (chrome && lease.targetId) await closeTab(chrome, lease.targetId).catch(() => {});
    removeLease(lease.jobId);
  }
}

async function confirmCountry(chrome, country) {
  let gate = vpnGate({ tabIp: "", hostIp: "", tabCountry: "", hostCountry: "", requireCountry: country });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const tab = await probeCountry(chrome);
      const host = await machineCountry();
      gate = vpnGate({
        tabIp: tab?.ip || "",
        hostIp: host.ip || "",
        tabCountry: tab?.loc || "",
        hostCountry: host.loc || "",
        requireCountry: country,
      });
      gate.machineIp = host.ip || "";
    } catch (error) {
      gate = { ok: false, routing: false, tabCountry: "", machineCountry: "", machineIp: "", reason: error.message };
    }
    if (gate.ok) return gate;
    if (!vpnInstalled()) return gate;
    await wakeVpn(chrome);
    await sleep(1000);
  }
  return gate;
}

function rememberRoute(gate, previous) {
  const next = {
    state: "connected",
    tabCountry: gate.tabCountry,
    machineCountry: gate.machineCountry,
    machineIp: gate.machineIp || "",
    verifiedAt: Date.now(),
    epoch: (previous?.epoch || 0) + 1,
  };
  writeRoute(next);
  return next;
}

async function acquireRoute(chrome, country, epochHolder) {
  return withRouteLock(stateDir, async () => {
    await dropStaleLeases(chrome);
    const owned = liveLeases(readLeases(), pidAlive).map((lease) => lease.targetId);
    await closeMuseTabs(chrome, owned);
    const route = readRoute();
    const countryOk = !country || String(route?.tabCountry || "").toUpperCase() === String(country).toUpperCase();
    if (routeFresh(route, Date.now()) && countryOk && route.machineIp) {
      try {
        const tab = await probeCountry(chrome);
        const still = vpnGate({
          tabIp: tab?.ip || "",
          hostIp: route.machineIp,
          tabCountry: tab?.loc || "",
          hostCountry: route.machineCountry || "",
          requireCountry: country,
        });
        if (still.ok) {
          route.verifiedAt = Date.now();
          writeRoute(route);
          epochHolder.epoch = route.epoch || 0;
          return { ok: true, route };
        }
      } catch {
        // The saved route could not be checked, so connect again.
      }
    }
    const gate = await confirmCountry(chrome, country);
    if (!gate.ok) return gate;
    const next = rememberRoute(gate, route);
    epochHolder.epoch = next.epoch;
    return { ok: true, route: next };
  });
}

async function repairRoute(chrome, country, epochSeen) {
  return withRouteLock(stateDir, async () => {
    const route = readRoute();
    if (route && route.epoch > epochSeen && routeFresh(route, Date.now()) && route.machineIp) {
      return { ok: true, route };
    }
    const gate = await confirmCountry(chrome, country);
    if (!gate.ok) return gate;
    const next = rememberRoute(gate, route);
    return { ok: true, route: next };
  });
}

async function openPage(chrome, targetId) {
  const list = await fetchJson(`http://${chrome.host}:${chrome.port}/json/list`);
  const page = list.find((target) => target.id === targetId && target.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("The Muse tab closed before it could be used.");
  const pageHost = new URL(page.url).hostname;
  if (pageHost !== "muse.ai" && pageHost !== "www.muse.ai") {
    throw new Error("The selected tab is no longer muse.ai.");
  }
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  return cdp;
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || "The Muse page rejected the script.");
  }
  return result.result?.value;
}

async function snapshot(cdp) {
  return evaluate(cdp, SNAPSHOT_EXPR);
}

async function readTabTrace(cdp) {
  const pageText = await evaluate(
    cdp,
    `Promise.race([
      fetch(${JSON.stringify(TRACE_URL)}, {cache:'no-store'}).then((response) => response.text()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000))
    ])`,
    true,
  );
  return parseTrace(pageText);
}

async function readExit(cdp) {
  const tab = await readTabTrace(cdp);
  const route = readRoute();
  let machine = { ip: route?.machineIp || "", loc: route?.machineCountry || "" };
  if (!machine.loc || !machine.ip) {
    try {
      const host = await machineCountry();
      machine = { ip: host.ip || machine.ip, loc: host.loc || machine.loc };
    } catch {
      // The route file and the Mac country cache were both empty.
    }
  }
  return { tab, machine };
}

async function tabGate(cdp, country) {
  let last;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const exit = await readExit(cdp);
      return vpnGate({
        tabIp: exit.tab.ip,
        hostIp: exit.machine.ip,
        tabCountry: exit.tab.loc,
        hostCountry: exit.machine.loc,
        requireCountry: country,
      });
    } catch (error) {
      last = error;
      if (!/execution context/i.test(error.message) || attempt === 9) throw error;
      await sleep(500);
    }
  }
  throw last || new Error("The Muse tab did not answer.");
}

function gateProblem(found, snap, vpn) {
  if (!found.target) return found.notes.join(" ") || "No normal muse.ai tab is open.";
  if (!snap) return "The Muse tab did not answer.";
  let host = "";
  try {
    host = new URL(snap.href).hostname;
  } catch {
    host = "";
  }
  if (host !== "muse.ai" && host !== "www.muse.ai") return "The selected tab left muse.ai.";
  if (!snap.composer) return "The Muse message box is not on this tab.";
  if (!vpn?.ok) return vpn?.reason || "The VPN extension is not routing this Muse window.";
  if (!snap.composerEmpty) return "The message box already has a draft. Clear it before sending.";
  return "";
}

async function inspect(country) {
  const found = await findTab();
  if (!found.target) return { found, snap: null, vpn: null };
  const cdp = await openPage(found.chrome, found.target.targetId);
  try {
    const snap = await snapshot(cdp);
    let vpn;
    try {
      const exit = await readExit(cdp);
      vpn = vpnGate({
        tabIp: exit.tab.ip,
        hostIp: exit.machine.ip,
        tabCountry: exit.tab.loc,
        hostCountry: exit.machine.loc,
        requireCountry: country,
      });
    } catch (error) {
      vpn = {
        ok: false,
        routing: false,
        tabCountry: "",
        machineCountry: "",
        reason: `Could not confirm this Muse tab's exit (${error.message}). The VPN extension is treated as off.`,
      };
    }
    return { found, snap, vpn };
  } finally {
    cdp.close();
  }
}

function statusPayload(report) {
  const problem = gateProblem(report.found, report.snap, report.vpn);
  return {
    ready: !problem,
    reason: problem,
    chrome: {
      running: Boolean(report.found.chrome),
      port: report.found.chrome?.port || null,
      window: "normal",
    },
    tab: report.found.target
      ? {
          title: report.found.target.title,
          url: report.found.target.url,
          window: "normal",
          port: report.found.chrome.port,
        }
      : null,
    composer: report.snap
      ? { found: report.snap.composer, empty: report.snap.composerEmpty }
      : null,
    vpn: report.vpn
      ? {
          routing: report.vpn.routing,
          tabCountry: report.vpn.tabCountry,
          machineCountry: report.vpn.machineCountry,
          reason: report.vpn.reason,
        }
      : null,
    notes: report.found.notes,
  };
}

function printStatus(payload, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (!payload.tab) {
    process.stdout.write("Muse tab: not in a normal window\n");
  } else {
    process.stdout.write(`Muse tab: ${payload.tab.title}\n`);
    process.stdout.write(`Window: normal, on 127.0.0.1:${payload.tab.port}\n`);
  }
  if (payload.composer) {
    process.stdout.write(`Composer: ${payload.composer.found ? (payload.composer.empty ? "empty" : "has a draft") : "missing"}\n`);
  }
  if (payload.vpn) {
    process.stdout.write(`VPN extension routing: ${payload.vpn.routing ? "yes" : "no"}\n`);
    process.stdout.write(`Tab exit country: ${payload.vpn.tabCountry || "unknown"}\n`);
    process.stdout.write(`Machine exit country: ${payload.vpn.machineCountry || "unknown"}\n`);
  }
  process.stdout.write(`Ready to send: ${payload.ready ? "yes" : "no"}\n`);
  if (payload.queue) {
    const running = payload.queue.filter((job) => job.state !== "queued").length;
    const waiting = payload.queue.filter((job) => job.state === "queued").length;
    process.stdout.write(`Queue: ${running} running, ${waiting} waiting\n`);
  }
  if (payload.reason) process.stdout.write(`\n${payload.reason}\n`);
}

function resolveJob({ mode = "text-to-video", prompt, firstFrame, lastFrame, references = [] }) {
  const allowed = ["text-to-video", "frame-to-video", "reference-to-video"];
  if (!allowed.includes(mode)) return { error: `Mode must be one of ${allowed.join(", ")}.` };
  const first = firstFrame ? path.resolve(firstFrame) : "";
  const last = lastFrame ? path.resolve(lastFrame) : "";
  const refs = references.map((file) => path.resolve(file));
  if (mode === "text-to-video" && (first || last || refs.length)) {
    return { error: "text-to-video takes a prompt only. Use frame-to-video or reference-to-video for images." };
  }
  if (mode === "frame-to-video" && refs.length) return { error: "frame-to-video does not take reference images." };
  if (mode === "frame-to-video" && !first) return { error: "frame-to-video needs a first frame." };
  if (mode === "reference-to-video" && !refs.length) {
    return { error: "reference-to-video needs at least one reference image." };
  }
  if (mode === "reference-to-video" && (first || last)) {
    return { error: "reference-to-video does not take first or last frames. One reference image is not a start frame." };
  }
  const images = mode === "frame-to-video" ? [first, last].filter(Boolean) : refs;
  const missing = images.filter((file) => !fs.existsSync(file));
  if (missing.length) return { error: `Image file not found: ${missing.join(", ")}` };
  let text = prompt;
  if (mode === "frame-to-video") {
    text = `Frame-to-video. The first attached image is the start frame.${last ? " The second attached image is the end frame." : ""}\n\n${prompt}`;
  }
  if (mode === "reference-to-video") {
    text = `Reference-to-video. The attached images are visual references, not start or end frames.\n\n${prompt}`;
  }
  return { mode, images, prompt: text };
}

const NEW_CHAT_EXPR = `(() => {
  const button = [...document.querySelectorAll("button, a")].find((node) => {
    const label = \`\${node.getAttribute("aria-label") || ""} \${node.innerText || ""}\`.toLowerCase();
    return label.includes("new chat") || label.includes("new conversation");
  });
  if (!button) return false;
  button.click();
  return true;
})()`;

async function focusPage(cdp) {
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
}

async function waitForComposer(cdp) {
  let snap = null;
  for (let attempt = 0; attempt < 20 && !snap?.composer; attempt += 1) {
    await sleep(500);
    snap = await snapshot(cdp);
  }
  if (snap?.userCount > 0) {
    const clicked = await evaluate(cdp, NEW_CHAT_EXPR);
    if (clicked) await sleep(800);
    else await cdp.send("Page.navigate", { url: "https://muse.ai/" }).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      snap = await snapshot(cdp);
      if (snap?.composer && snap.userCount === 0) break;
    }
  }
  return snap || (await snapshot(cdp));
}

async function openPageWhenReady(chrome, targetId) {
  let last;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let cdp;
    try {
      cdp = await openPage(chrome, targetId);
      await evaluate(cdp, "document.readyState");
      return cdp;
    } catch (error) {
      last = error;
      try {
        cdp?.close();
      } catch {
        // The page socket is already closed.
      }
      await sleep(500);
    }
  }
  throw last || new Error("The Muse tab did not load.");
}

async function openJobPage(chrome, lease) {
  lease.state = "opening";
  lease.targetId = await createMuseTab(chrome);
  saveLease(lease);
  const cdp = await openPageWhenReady(chrome, lease.targetId);
  await focusPage(cdp);
  return cdp;
}

async function ensureTabRouted(chrome, cdp, country, epochHolder, lease) {
  let current = cdp;
  let gate;
  try {
    gate = await tabGate(current, country);
  } catch (error) {
    gate = { ok: false, reason: error.message };
  }
  if (gate.ok) return { ok: true, cdp: current, gate };
  const repaired = await repairRoute(chrome, country, epochHolder.epoch);
  if (!repaired.ok) return { ok: false, reason: repaired.reason || gate.reason || "The VPN route dropped before the prompt was sent." };
  epochHolder.epoch = repaired.route.epoch;
  try {
    current.close();
  } catch {
    // The page socket is already closed.
  }
  await closeTab(chrome, lease.targetId).catch(() => {});
  current = await openJobPage(chrome, lease);
  try {
    gate = await tabGate(current, country);
  } catch (error) {
    return { ok: false, cdp: current, reason: error.message };
  }
  if (!gate.ok) return { ok: false, cdp: current, reason: gate.reason };
  return { ok: true, cdp: current, gate };
}

async function watchRouteDuringGeneration(chrome, cdp, country, epochHolder) {
  let gate;
  try {
    gate = await tabGate(cdp, country);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (gate.ok) return { ok: true };
  const repaired = await repairRoute(chrome, country, epochHolder.epoch);
  if (!repaired.ok) return { ok: false, reason: repaired.reason || "The VPN route dropped during generation." };
  epochHolder.epoch = repaired.route.epoch;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(1000);
    try {
      const again = await tabGate(cdp, country);
      if (again.ok) return { ok: true, routeInterrupted: true };
    } catch {
      // The tab trace is still loading after the VPN reconnect.
    }
  }
  return { ok: true, routeInterrupted: true };
}

function writeResult(args, payload, okStream) {
  if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (okStream) process.stdout.write(`${payload}\n`);
  else process.stderr.write(`${payload}\n`);
}

async function runSend(args, job, promptText) {
  const jobId = newJobId();
  const lease = {
    jobId,
    pid: process.pid,
    state: "queued",
    targetId: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prompt: String(promptText || "").slice(0, 80),
    out: args.out || "",
  };
  saveLease(lease);
  process.stderr.write(`queued ${jobId}\n`);
  let chrome = null;
  let cdp = null;
  let reported = false;
  const epochHolder = { epoch: 0 };
  const report = (code, message, extra = {}) => {
    if (reported) return code;
    reported = true;
    const payload = { ok: false, error: message, jobId, ...extra };
    if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stderr.write(`${message}\n`);
    return code;
  };
  let releasing = null;
  const release = () => {
    if (releasing) return releasing;
    releasing = (async () => {
      try {
        cdp?.close();
      } catch {
        // The page socket is already closed.
      }
      cdp = null;
      await withRouteLock(stateDir, async () => {
        if (chrome && lease.targetId) await closeTab(chrome, lease.targetId).catch(() => {});
        lease.targetId = "";
        removeLease(jobId);
        if (chrome) await dropStaleLeases(chrome);
      }).catch(() => {});
      await sleep(3000);
      await withRouteLock(stateDir, async () => {
        if (chrome) await dropStaleLeases(chrome);
        if (!shouldDisconnect(readLeases(), pidAlive)) return;
        if (!chrome) return;
        await closeMuseTabs(chrome).catch(() => {});
        await disconnectVpn(chrome).catch(() => {});
        const previous = readRoute();
        writeRoute({
          state: "off",
          tabCountry: "",
          machineCountry: previous?.machineCountry || "",
          machineIp: previous?.machineIp || "",
          verifiedAt: 0,
          epoch: previous?.epoch || 0,
        });
      }).catch(() => {});
    })();
    return releasing;
  };

  const onSignal = () => {
    Promise.race([release(), sleep(20000)]).finally(() => process.exit(1));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);

  let exitCode = 1;
  try {
    exitCode = await perform();
  } catch (error) {
    if (!reported) exitCode = report(1, error.message);
  } finally {
    await release();
  }
  return exitCode;

  async function perform() {
    const deadline = Date.now() + args.queueWait * 1000;
    let admitted = false;
    while (Date.now() < deadline) {
      admitted = await withRouteLock(stateDir, async () => {
        await dropStaleLeases(null);
        const decision = admit(liveLeases(readLeases(), pidAlive), 1, jobId);
        if (!decision.admitted) return false;
        lease.state = "routing";
        saveLease(lease);
        return true;
      });
      if (admitted) break;
      await sleep(250);
    }
    if (!admitted) return report(6, "Timed out waiting for the Muse Video queue.");

    process.stderr.write(`started ${jobId}\n`);
    await ensureChrome();
    const running = ownChrome();
    chrome = { ...running, host: debugHost(running.addr) };
    const routed = await acquireRoute(chrome, args.country, epochHolder);
    if (!routed.ok) {
      return report(3, routed.reason || "Muse stayed closed because the VPN route was not confirmed.");
    }

    cdp = await openJobPage(chrome, lease);
    const routedPage = await ensureTabRouted(chrome, cdp, args.country, epochHolder, lease);
    cdp = routedPage.cdp || cdp;
    if (!routedPage.ok) return report(3, routedPage.reason || "The VPN route dropped before the prompt was sent.");

    let before = await waitForComposer(cdp);
    if (before?.href) {
      lease.href = before.href;
      saveLease(lease);
    }
    const problem = gateProblem({ target: { url: before?.href || "https://muse.ai/" }, notes: [] }, before, routedPage.gate);
    if (problem) return report(3, problem);
    {
      // The page may still be listing older clips. Wait until it stops changing before taking the baseline.
      const settled = await settledSnapshot(cdp);
      before = { ...before, ...settled, href: before.href || settled.href };
    }
    logJob(jobId, { state: "ready", prompt: promptText, mode: job.mode, images: job.images, href: before.href, out: args.out || "" });

    if (job.images.length) {
      lease.state = "attaching";
      saveLease(lease);
      const attached = await attachImages(cdp, job.images);
      if (!attached.ok) {
        return report(5, `Could not attach the image (${attached.error}). The prompt was not sent.`, { images: job.images });
      }
    }

    lease.state = "sending";
    saveLease(lease);
    const beforeCount = await countPromptOnPage(cdp, job.prompt);
    const sent = await evaluate(cdp, sendExpression(job.prompt), true);
    if (!sent?.ok) return report(5, `Muse did not accept the prompt (${sent?.error || "unknown"}).`);

    const started = Date.now();
    let confirmed = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(500);
      const now = await snapshot(cdp);
      const nowCount = await countPromptOnPage(cdp, job.prompt);
      if (nowCount > beforeCount || countLiteral(now.text, job.prompt) > countLiteral(before.text, job.prompt)) {
        confirmed = true;
        break;
      }
    }
    if (!confirmed) {
      return report(5, "The Send button was clicked, but the Muse transcript did not show the prompt. It was not clicked again.");
    }

    lease.state = "generating";
    saveLease(lease);
    logJob(jobId, { state: "generating", sentAt: started });
    let routeInterrupted = false;
    const waited = await waitForTurn(cdp, before, args.wait * 1000, job.prompt, async () => {
      const watched = await watchRouteDuringGeneration(chrome, cdp, args.country, epochHolder);
      if (watched.routeInterrupted) routeInterrupted = true;
      if (!watched.ok) return { abort: true, reason: watched.reason };
      return null;
    });
    if (waited.aborted) return report(3, waited.reason || "The VPN route dropped during generation.");

    lease.state = "saving";
    saveLease(lease);
    const reply = extractReply(before.text, waited.snap.text, job.prompt);
    const outDir = path.resolve(args.out || "muse-out");
    let files = args.download ? await downloadNewMedia(cdp, before, waited.snap, outDir, jobId) : [];
    // Muse sometimes shows an older clip first. If only an already-saved clip came back, keep waiting for the real one.
    for (let again = 0; again < 3 && args.download && files.length && files.every((file) => file.stale); again += 1) {
      const left = args.wait * 1000 - (Date.now() - started);
      if (left < 15000) break;
      process.stderr.write("Muse showed an old clip; still waiting for the new one.\n");
      before = {
        ...before,
        videos: [...new Set([...before.videos, ...waited.snap.videos])],
        openers: [...new Set([...before.openers, ...waited.snap.openers])],
      };
      const next = await waitForTurn(cdp, before, left, job.prompt, null);
      waited.snap = next.snap;
      files = await downloadNewMedia(cdp, before, next.snap, outDir, jobId);
    }
    const stale = files.filter((file) => file.stale);
    logJob(jobId, { state: files.some((file) => file.kind === "video" && !file.stale) ? "done" : "no-new-video", files, finishedAt: Date.now() });
    const newVideos = waited.snap.openers.filter((label) => !before.openers.includes(label)).slice(-1);
    const savedVideo = files.some((file) => file.kind === "video" && !file.stale);
    const complete = savedVideo || (!args.download && newVideos.length > 0);
    reported = true;
    const payload = {
      ok: complete,
      complete,
      jobId,
      mode: job.mode,
      prompt: promptText,
      images: job.images,
      reply,
      videos: newVideos,
      files,
      stale: stale.length ? "Muse returned a video that was already downloaded earlier. It was not saved again." : undefined,
      elapsedMs: Date.now() - started,
      routeInterrupted,
      tab: { window: "normal", port: chrome.port },
    };
    if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`${reply}\n`);
      for (const file of files) process.stdout.write(`${file.path}\n`);
      if (!complete) process.stderr.write("No new mp4 was saved before the wait ended.\n");
    }
    return complete ? 0 : 4;
  }
}

async function printLatestJob(args) {
  const lease = readLeases().find((item) => item.jobId === args.job);
  if (!lease) {
    const message = `Job ${args.job} is not in the queue.`;
    writeResult(args, args.json ? { ok: false, error: message } : message, false);
    return 3;
  }
  if (!lease.targetId) {
    const payload = { ok: true, jobId: lease.jobId, state: lease.state, tab: null, videos: [] };
    if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`${lease.state}\n`);
    return 0;
  }
  const running = ownChrome();
  if (!running) {
    const message = "Muse Chrome is not running.";
    writeResult(args, args.json ? { ok: false, error: message, jobId: lease.jobId } : message, false);
    return 3;
  }
  const chrome = { ...running, host: debugHost(running.addr) };
  let cdp;
  try {
    cdp = await openPage(chrome, lease.targetId);
    const snap = await snapshot(cdp);
    const turn = snap?.text ? snap.text.slice(snap.text.lastIndexOf("User message:")) : "";
    const payload = { ok: true, jobId: lease.jobId, state: lease.state, tab: snap.href, turn: turn.trim(), videos: snap.openers || [] };
    if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`${payload.turn}\n`);
    return 0;
  } catch (error) {
    writeResult(args, args.json ? { ok: false, error: error.message, jobId: lease.jobId } : error.message, false);
    return 3;
  } finally {
    cdp?.close();
  }
}

async function attachImages(cdp, images) {
  await cdp.send("DOM.enable");
  const names = images.map((file) => path.basename(file));
  if (new Set(names).size !== names.length) return { ok: false, error: "attach-duplicate-names", names };
  const visibleNames = () =>
    evaluate(
      cdp,
      `(() => {
        const alts = [...document.querySelectorAll("img")].map((img) => img.alt || "");
        return ${JSON.stringify(names)}.filter((name) => alts.includes(name));
      })()`,
    );
  let visible = [];
  // Large PNGs can take several seconds to appear. Wait, and set the files once more if nothing shows up.
  for (let round = 0; round < 2; round += 1) {
    const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const found = await cdp.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!found.nodeId) return { ok: false, error: "attach-input-missing" };
    await cdp.send("DOM.setFileInputFiles", { nodeId: found.nodeId, files: images });
    for (let tick = 0; tick < 30; tick += 1) {
      await sleep(500);
      visible = (await visibleNames()) || [];
      if (visible.length >= names.length) return { ok: true, names, visible };
      if (round === 0 && tick >= 14 && visible.length === 0) break;
    }
  }
  return { ok: false, error: "attach-not-visible", names, visible };
}

function sendExpression(prompt) {
  return `(async () => {
    const prompt = ${JSON.stringify(prompt)};
    const box = document.querySelector('textarea[aria-label="Message"]');
    if (!box) return { ok: false, error: 'composer-missing' };
    if (box.value.trim()) return { ok: false, error: 'composer-not-empty' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, prompt);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const button = [...document.querySelectorAll('button')].find((node) => {
      return node.getAttribute('aria-label') === 'Send' && node.getBoundingClientRect().width > 0;
    });
    if (!button) {
      setter.call(box, '');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: false, error: 'send-button-missing' };
    }
    button.click();
    return { ok: true };
  })()`;
}

function countPromptExpression(prompt) {
  return `(() => {
    const prompt = ${JSON.stringify(prompt)};
    const box = document.querySelector('textarea[aria-label="Message"]');
    let text = document.body ? document.body.innerText : "";
    if (box && box.value) text = text.split(box.value).join("");
    let count = 0;
    let index = 0;
    while (prompt && index <= text.length) {
      const found = text.indexOf(prompt, index);
      if (found === -1) return count;
      count += 1;
      index = found + prompt.length;
    }
    return count;
  })()`;
}

async function countPromptOnPage(cdp, prompt) {
  const count = await evaluate(cdp, countPromptExpression(prompt));
  return Number(count) || 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const seenVideosFile = path.join(stateDir, "seen-videos.json");
const jobsDir = path.join(stateDir, "job-logs"); // not "jobs": that folder holds the live queue leases

function readSeenVideos() {
  return readJson(seenVideosFile) || {};
}

function rememberVideo(hash, info) {
  const seen = readSeenVideos();
  seen[hash] = info;
  writeJsonAtomic(seenVideosFile, seen);
}

// Muse pages can list older clips. Hash every mp4 next to the output folder so an old clip is never mistaken for a new one.
function seedSeenVideos(outDir) {
  const seen = readSeenVideos();
  const root = path.dirname(outDir);
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || count > 300) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".mp4") && !entry.name.startsWith(".partial")) {
        count += 1;
        try {
          const hash = sha256File(full);
          if (!seen[hash]) seen[hash] = { path: full, jobId: "seeded", at: Date.now() };
        } catch {
          // Unreadable file: skip it.
        }
      }
    }
  };
  walk(root, 0);
  writeJsonAtomic(seenVideosFile, seen);
}

function logJob(jobId, patch) {
  const file = path.join(jobsDir, `${jobId}.json`);
  const current = readJson(file) || { jobId, createdAt: Date.now() };
  writeJsonAtomic(file, { ...current, ...patch, updatedAt: Date.now() });
}

function readJobLog(jobId) {
  return readJson(path.join(jobsDir, `${jobId}.json`));
}

function listJobLogs(limit = 20) {
  let names = [];
  try {
    names = fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => readJson(path.join(jobsDir, name)))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}

async function settledSnapshot(cdp) {
  let snap = await snapshot(cdp);
  let signature = "";
  let stableSince = Date.now();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(700);
    snap = await snapshot(cdp);
    const next = [snap.videos.length, snap.openers.length, snap.text.length, snap.images.length].join("|");
    if (next !== signature) {
      signature = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 2500) break;
  }
  return snap;
}

async function waitForTurn(cdp, before, timeoutMs, prompt, onTick) {
  const deadline = Date.now() + timeoutMs;
  let signature = "";
  let stableSince = 0;
  let latest = before;
  let sawUser = false;
  let lastTick = Date.now();
  while (Date.now() < deadline) {
    await sleep(1000);
    if (onTick && Date.now() - lastTick >= 30000) {
      lastTick = Date.now();
      const tick = await onTick();
      if (tick?.abort) return { complete: false, snap: latest, sawUser, aborted: true, reason: tick.reason || "" };
    }
    latest = await snapshot(cdp);
    if (latest.userCount > before.userCount || countLiteral(latest.text, prompt) > countLiteral(before.text, prompt)) {
      sawUser = true;
    }
    const videoArrived = latest.videos.length > before.videos.length;
    const grew =
      latest.assistantCount > before.assistantCount ||
      videoArrived ||
      latest.images.length > before.images.length ||
      latest.text.length > before.text.length + 20;
    const nextSignature = [
      latest.assistantCount,
      latest.text.length,
      latest.videos.length,
      latest.images.length,
      latest.openers.length,
      latest.taskStop,
      latest.stopNear,
    ].join("|");
    if (nextSignature === signature) {
      if (!stableSince) stableSince = Date.now();
    } else {
      signature = nextSignature;
      stableSince = 0;
    }
    const stableFor = stableSince ? Date.now() - stableSince : 0;
    const busy = latest.stopNear || latest.taskStop;
    if ((sawUser || videoArrived) && grew && stableFor >= 4000 && !busy) {
      return { complete: true, snap: latest, sawUser: sawUser || videoArrived };
    }
  }
  return { complete: false, snap: latest, sawUser };
}

function extensionFor(type, fallback) {
  if (type.includes("mp4")) return ".mp4";
  if (type.includes("webm")) return ".webm";
  if (type.includes("png")) return ".png";
  if (type.includes("jpeg")) return ".jpg";
  if (type.includes("webp")) return ".webp";
  return fallback;
}

function fileName(preferred, index, extension) {
  const cleaned = String(preferred || "")
    .replace(/^Open animated video\s+/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  if (cleaned) return cleaned.includes(".") ? cleaned : `${cleaned}${extension}`;
  return `muse-${index + 1}${extension}`;
}

async function saveMedia(cdp, url, dest) {
  const prepared = await evaluate(
    cdp,
    `(async () => {
      const response = await fetch(${JSON.stringify(url)});
      if (!response.ok) throw new Error('media fetch failed');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 80 * 1024 * 1024) throw new Error('media is larger than 80MB');
      window.__musePull = bytes;
      return { size: bytes.length, type: response.headers.get('content-type') || '' };
    })()`,
    true,
  );
  const handle = fs.openSync(dest, "w");
  try {
    const chunk = 48 * 1024;
    for (let offset = 0; offset < prepared.size; offset += chunk) {
      const b64 = await evaluate(
        cdp,
        `(() => {
          const slice = window.__musePull.subarray(${offset}, ${offset + chunk});
          let binary = '';
          const step = 4096;
          for (let index = 0; index < slice.length; index += step) {
            binary += String.fromCharCode.apply(null, slice.subarray(index, index + step));
          }
          return btoa(binary);
        })()`,
      );
      fs.writeSync(handle, Buffer.from(b64, "base64"));
    }
  } finally {
    fs.closeSync(handle);
    await evaluate(cdp, "delete window.__musePull").catch(() => {});
  }
  return { ...prepared, bytes: fs.statSync(dest).size };
}

async function downloadNewMedia(cdp, before, after, outDir, jobId) {
  fs.mkdirSync(outDir, { recursive: true });
  seedSeenVideos(outDir);
  const seenBefore = readSeenVideos();
  const beforeVideos = new Set(before.videos);
  const beforeOpeners = new Set(before.openers);
  const newVideos = after.videos.filter((url) => !beforeVideos.has(url)).slice(-1);
  const newOpeners = after.openers.filter((label) => !beforeOpeners.has(label)).slice(-1);
  const saved = [];
  const items = newVideos.map((url, index) => ({ url, kind: "video", label: newOpeners[index] || "" }));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const temp = path.join(outDir, `.partial-${jobId}-${index}`);
    try {
      const media = await saveMedia(cdp, item.url, temp);
      const hash = sha256File(temp);
      if (seenBefore[hash]) {
        fs.rmSync(temp, { force: true });
        saved.push({ kind: item.kind, stale: true, duplicateOf: seenBefore[hash].path, sha256: hash, bytes: media.bytes });
        process.stderr.write(`skipped: same video as ${seenBefore[hash].path}\n`);
        continue;
      }
      const extension = extensionFor(media.type, item.kind === "video" ? ".mp4" : ".png");
      const name = fileName(item.label, index, extension);
      let dest = path.join(outDir, name);
      let suffix = 2;
      for (;;) {
        try {
          const fd = fs.openSync(dest, "wx");
          fs.closeSync(fd);
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const parsed = path.parse(name);
          dest = path.join(outDir, `${parsed.name}-${suffix}${parsed.ext}`);
          suffix += 1;
        }
      }
      fs.renameSync(temp, dest);
      rememberVideo(hash, { path: dest, jobId, at: Date.now() });
      saved.push({ kind: item.kind, path: dest, bytes: media.bytes, type: media.type, sha256: hash });
      process.stderr.write(`saved ${dest}\n`);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }
  return saved;
}

async function runCollect(args) {
  // Download the newest video from a Muse tab that is already open, skipping any clip saved before.
  const running = ownChrome();
  if (!running) {
    writeResult(args, args.json ? { ok: false, error: "Muse Chrome is not running." } : "Muse Chrome is not running.", false);
    return 3;
  }
  const chrome = { ...running, host: debugHost(running.addr) };
  const log = args.job ? readJobLog(args.job) : null;
  const list = await fetchJson(`http://${chrome.host}:${chrome.port}/json/list`);
  const pages = list.filter((target) => target.type === "page" && /(^|\.)muse\.ai$/.test(new URL(target.url).hostname));
  const page = (log?.href && pages.find((target) => target.url === log.href)) || pages[0];
  if (!page) {
    writeResult(args, args.json ? { ok: false, error: "No open Muse tab. Open the job page first." } : "No open Muse tab.", false);
    return 3;
  }
  const cdp = await openPage(chrome, page.id);
  try {
    const snap = await settledSnapshot(cdp);
    const outDir = path.resolve(args.out || log?.out || "muse-out");
    const files = await downloadNewMedia(cdp, { videos: [], openers: [] }, snap, outDir, args.job || "collect");
    const fresh = files.filter((file) => !file.stale);
    if (args.job) logJob(args.job, { state: fresh.length ? "done" : "no-new-video", files });
    const payload = { ok: fresh.length > 0, files, tab: page.url };
    if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else for (const file of files) process.stdout.write(`${file.path || "(same as earlier) " + file.duplicateOf}\n`);
    return fresh.length ? 0 : 4;
  } finally {
    cdp.close();
  }
}

function fail(code, message, extra = {}) {
  const payload = { ok: false, error: message, ...extra };
  if (extra.json) {
    delete payload.json;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }
  const command = args._[0];
  if (!["chrome", "status", "latest", "send", "jobs", "collect"].includes(command)) fail(2, HELP.trim());
  if (command !== "send" && args.wait !== 300 && (!Number.isFinite(args.wait) || args.wait < 1)) {
    fail(2, "--wait must be a positive number of seconds.");
  }
  if (command === "jobs") {
    const rows = args.job ? [readJobLog(args.job)].filter(Boolean) : listJobLogs(Number(args.limit) || 20);
    const live = new Set(readLeases().map((lease) => lease.jobId));
    const out = rows.map((row) => ({ ...row, live: live.has(row.jobId) }));
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, jobs: out }, null, 2)}\n`);
    else for (const row of out) process.stdout.write(`${row.jobId}  ${row.state}${row.live ? " (live)" : ""}  ${String(row.prompt || "").slice(0, 60)}\n`);
    process.exit(0);
  }
  if (command === "collect") {
    process.exit(await runCollect(args));
  }
  if (command === "chrome") await ensureChrome();
  if (command === "latest" && args.job) {
    const code = await printLatestJob(args);
    process.exit(code);
  }
  if (command !== "send") {
    let report;
    try {
      report = await inspect(args.country);
    } catch (error) {
      report = { found: { chrome: null, target: null, notes: [error.message] }, snap: null, vpn: null };
    }
    if (command === "latest") {
      if (!report.found.target) {
        fail(3, report.found.notes.join(" ") || "Muse is not open.", { json: args.json });
      }
      const turn = report.snap?.text ? report.snap.text.slice(report.snap.text.lastIndexOf("User message:")) : "";
      const payload = { ok: true, tab: report.found.target.url, turn: turn.trim(), videos: report.snap?.openers || [] };
      if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stdout.write(`${payload.turn}\n`);
      process.exit(0);
    }
    if (command === "chrome" && !args.json) {
      process.stdout.write("Muse Chrome is separate from your main Chrome. This command does not open Muse.\n");
    }
    const payload = statusPayload(report);
    payload.queue = queueView();
    payload.route = readRoute();
    printStatus(payload, args.json);
    process.exit(0);
  }

  if (!Number.isFinite(args.wait) || args.wait < 1) fail(2, "--wait must be a positive number of seconds.", { json: args.json });
  if (!Number.isFinite(args.queueWait) || args.queueWait < 1) {
    fail(2, "--queue-wait must be a positive number of seconds.", { json: args.json });
  }
  const prompt = args.prompt ?? (args.promptFile ? fs.readFileSync(args.promptFile, "utf8").trim() : args._.slice(1).join(" ").trim());
  if (!prompt) fail(2, "Pass the prompt after send, or use --prompt.", { json: args.json });
  const job = resolveJob({
    mode: args.mode || "text-to-video",
    prompt,
    firstFrame: args.firstFrame,
    lastFrame: args.lastFrame,
    references: args.references || [],
  });
  if (job.error) fail(2, job.error, { json: args.json });
  const code = await runSend(args, job, prompt);
  process.exit(code);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
