#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
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

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const VPN_ID = "eppiocemhmnlbhjplcgkofciiegomcon";
const VPN_STORE = `https://chromewebstore.google.com/detail/urban-vpn-proxy/${VPN_ID}`;
const HELP = `muse-tab — one pipeline for a Muse video

send starts the separate Chrome on a blank page, connects the VPN extension,
and opens Muse only after the exit country differs from this Mac. It saves
the new mp4, closes the Muse page, then disconnects the VPN.
status and latest only look. They do not open Muse. The main Chrome is never used.

  muse-tab send --prompt TEXT [--wait 180] [--download] [--out DIR] [--json]
  muse-tab status [--json]
  muse-tab latest [--json]

Exit codes: 0 mp4 saved, 2 usage, 3 VPN route refused, 4 no mp4, 5 send failed.
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
    country: process.env.MUSE_TAB_COUNTRY || "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--download") out.download = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--wait") out.wait = Number(argv[++i]);
    else if (arg === "--country") out.country = argv[++i] || "";
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--prompt") out.prompt = argv[++i];
    else if (arg === "--prompt-file") out.promptFile = argv[++i];
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
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || "CDP error"));
    else resolve(message.result ?? {});
  });
  return {
    ready,
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
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
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
      notes: ["Muse Chrome is not running. Start the separate window with: muse-tab chrome"],
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

async function ensureMuseTab(chrome) {
  const report = await readChrome(chrome);
  if (report.picked.ok) return;
  await withBrowser(report.chrome, (browser) => browser.send("Target.createTarget", { url: "https://muse.ai/" }));
}

async function wakeVpn(chrome) {
  const popupUrl = `chrome-extension://${VPN_ID}/popup/index.html`;
  const created = await withBrowser(chrome, (browser) => browser.send("Target.createTarget", { url: popupUrl }));
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
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const text = await evaluate(cdp, "document.body ? document.body.innerText : ''");
        if (String(text).includes("Connected")) return;
        await evaluate(
          cdp,
          `(() => {
            const button = [...document.querySelectorAll('button')].find((node) => {
              const rect = node.getBoundingClientRect();
              return rect.width > 70 && rect.height > 70;
            });
            if (button) button.click();
          })()`,
        );
        await sleep(1000);
      }
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
        const loc = parseTrace(text).loc;
        if (loc) return loc;
      } catch {
        // The probe page is still loading.
      } finally {
        cdp.close();
      }
    }
    return "";
  } finally {
    await withBrowser(chrome, (browser) => browser.send("Target.closeTarget", { targetId })).catch(() => {});
  }
}

async function machineCountry() {
  const response = await fetch(TRACE_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  return parseTrace(await response.text()).loc;
}

async function closeMuseTabs(chrome) {
  const list = await fetchJson(`http://${chrome.host}:${chrome.port}/json/list`);
  const tabs = list.filter((target) => {
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

async function ensureRouted(chrome, country) {
  let gate = vpnGate({ tabIp: "", hostIp: "", tabCountry: "", hostCountry: "", requireCountry: country });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tabCountry = await probeCountry(chrome);
    const hostCountry = await machineCountry();
    gate = vpnGate({
      tabIp: tabCountry,
      hostIp: hostCountry,
      tabCountry,
      hostCountry,
      requireCountry: country,
    });
    if (gate.ok) return gate;
    await closeMuseTabs(chrome);
    if (!vpnInstalled()) return gate;
    await wakeVpn(chrome);
    await sleep(1000);
  }
  return gate;
}

async function openMuseAfterVpn(country) {
  await ensureChrome();
  const running = ownChrome();
  const chrome = { ...running, host: debugHost(running.addr) };
  const gate = await ensureRouted(chrome, country);
  if (!gate.ok) return { chrome, gate, report: null };
  await ensureMuseTab(chrome);
  let report = await inspect(country);
  for (let attempt = 0; attempt < 12 && report.found.target && !report.snap?.composer; attempt += 1) {
    await sleep(500);
    report = await inspect(country);
  }
  if (report.vpn && !report.vpn.ok) {
    await closeMuseTabs(chrome);
    const again = await ensureRouted(chrome, country);
    if (!again.ok) return { chrome, gate: again, report: null };
    await ensureMuseTab(chrome);
    report = await inspect(country);
  }
  return { chrome, gate, report };
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

async function readExit(cdp) {
  const [pageText, hostResponse] = await Promise.all([
    evaluate(
      cdp,
      `Promise.race([
        fetch(${JSON.stringify(TRACE_URL)}, {cache:'no-store'}).then((response) => response.text()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000))
      ])`,
      true,
    ),
    fetch(TRACE_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) }),
  ]);
  const hostText = await hostResponse.text();
  return { tab: parseTrace(pageText), machine: parseTrace(hostText) };
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
  if (payload.reason) process.stdout.write(`\n${payload.reason}\n`);
}

function acquireLock() {
  const dir = stateDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "send.lock");
  const write = () => {
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  try {
    write();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = Number(fs.readFileSync(file, "utf8"));
    let alive = false;
    try {
      process.kill(owner, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(`Another muse-tab send is already running (pid ${owner}).`);
    }
    fs.unlinkSync(file);
    write();
  }
  const release = () => {
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      // The lock is already gone.
    }
  };
  process.on("exit", release);
  return release;
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
    await new Promise((resolve) => setTimeout(resolve, 80));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTurn(cdp, before, timeoutMs, prompt) {
  const deadline = Date.now() + timeoutMs;
  let signature = "";
  let stableSince = 0;
  let latest = before;
  let sawUser = false;
  while (Date.now() < deadline) {
    await sleep(1000);
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

async function downloadNewMedia(cdp, before, after, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const beforeVideos = new Set(before.videos);
  const beforeOpeners = new Set(before.openers);
  const newVideos = after.videos.filter((url) => !beforeVideos.has(url));
  const newOpeners = after.openers.filter((label) => !beforeOpeners.has(label));
  const saved = [];
  const items = newVideos.map((url, index) => ({ url, kind: "video", label: newOpeners[index] || "" }));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const temp = path.join(outDir, `.partial-${process.pid}-${index}`);
    try {
      const media = await saveMedia(cdp, item.url, temp);
      const extension = extensionFor(media.type, item.kind === "video" ? ".mp4" : ".png");
      let name = fileName(item.label, index, extension);
      let dest = path.join(outDir, name);
      let suffix = 2;
      while (fs.existsSync(dest)) {
        const parsed = path.parse(name);
        dest = path.join(outDir, `${parsed.name}-${suffix}${parsed.ext}`);
        suffix += 1;
      }
      fs.renameSync(temp, dest);
      saved.push({ kind: item.kind, path: dest, bytes: media.bytes, type: media.type });
      process.stderr.write(`saved ${dest}\n`);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }
  return saved;
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
  if (!["chrome", "status", "latest", "send"].includes(command)) fail(2, HELP.trim());
  if (command !== "send" && args.wait !== 300 && (!Number.isFinite(args.wait) || args.wait < 1)) {
    fail(2, "--wait must be a positive number of seconds.");
  }
  if (command === "chrome") await ensureChrome();
  if (command !== "send") {
    const report = await inspect(args.country);
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
    printStatus(statusPayload(report), args.json);
    process.exit(0);
  }

  if (!Number.isFinite(args.wait) || args.wait < 1) fail(2, "--wait must be a positive number of seconds.");
  const prompt = args.prompt ?? (args.promptFile ? fs.readFileSync(args.promptFile, "utf8").trim() : args._.slice(1).join(" ").trim());
  if (!prompt) fail(2, "Pass the prompt after send, or use --prompt.", { json: args.json });

  const opened = await openMuseAfterVpn(args.country);
  const shutdown = async () => {
    if (!opened.chrome) return;
    await closeMuseTabs(opened.chrome).catch(() => {});
    await disconnectVpn(opened.chrome).catch(() => {});
  };
  if (!opened.gate.ok || !opened.report?.found?.target) {
    await shutdown();
    fail(3, opened.gate.reason || opened.report?.found?.notes?.join(" ") || "Muse stayed closed because the VPN route was not confirmed.", {
      json: args.json,
    });
  }

  const report = opened.report;
  let release;
  let cdp;
  let exitCode = 0;
  try {
    release = acquireLock();
    cdp = await openPage(report.found.chrome, report.found.target.targetId);
    const before = await snapshot(cdp);
    const exit = await readExit(cdp);
    const vpn = vpnGate({
      tabIp: exit.tab.ip,
      hostIp: exit.machine.ip,
      tabCountry: exit.tab.loc,
      hostCountry: exit.machine.loc,
      requireCountry: args.country,
    });
    const problem = gateProblem(report.found, before, vpn);
    if (problem) {
      exitCode = 3;
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, error: problem }, null, 2)}\n`);
      else process.stderr.write(`${problem}\n`);
    } else {
      const sent = await evaluate(cdp, sendExpression(prompt), true);
      if (!sent?.ok) {
        exitCode = 5;
        const message = `Muse did not accept the prompt (${sent?.error || "unknown"}).`;
        if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
        else process.stderr.write(`${message}\n`);
      } else {
        const started = Date.now();
        let confirmed = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await sleep(500);
          const now = await snapshot(cdp);
          if (countLiteral(now.text, prompt) > countLiteral(before.text, prompt)) {
            confirmed = true;
            break;
          }
        }
        if (!confirmed) {
          exitCode = 5;
          const message = "The Send button was clicked, but the Muse transcript did not show the prompt. It was not clicked again.";
          if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
          else process.stderr.write(`${message}\n`);
        } else {
          const waited = await waitForTurn(cdp, before, args.wait * 1000, prompt);
          const reply = extractReply(before.text, waited.snap.text, prompt);
          const outDir = path.resolve(args.out || "muse-out");
          const files = args.download ? await downloadNewMedia(cdp, before, waited.snap, outDir) : [];
          const newVideos = waited.snap.openers.slice(before.openers.length);
          const savedVideo = files.some((file) => file.kind === "video");
          const complete = savedVideo || (!args.download && newVideos.length > 0);
          exitCode = complete ? 0 : 4;
          const payload = {
            ok: complete,
            complete,
            prompt,
            reply,
            videos: newVideos,
            files,
            elapsedMs: Date.now() - started,
            tab: { window: "normal", port: report.found.chrome.port },
          };
          if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
          else {
            process.stdout.write(`${reply}\n`);
            for (const file of files) process.stdout.write(`${file.path}\n`);
            if (!complete) process.stderr.write("No new mp4 was saved before the wait ended.\n");
          }
        }
      }
    }
  } finally {
    cdp?.close();
    await shutdown();
    release?.();
  }
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
