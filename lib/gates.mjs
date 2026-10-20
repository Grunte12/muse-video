export function parseChromeCommand(line) {
  if (!line || line.includes("Google Chrome Helper") || line.includes("chrome_crashpad")) return null;
  if (!line.includes("/Google Chrome ")) return null;
  if (!line.includes("--remote-debugging-port=")) return null;
  const port = Number(line.match(/--remote-debugging-port=(\d+)/)?.[1]);
  const dir = line.match(/--user-data-dir=(\S+)/)?.[1] || "";
  const addr = line.match(/--remote-debugging-address=(\S+)/)?.[1] || "127.0.0.1";
  if (!port || !dir) return null;
  return { port, dir, addr };
}

export function sameProfile(dir, ownDir) {
  const norm = (value) => String(value || "").replaceAll("\\", "/").replace(/\/+$/, "");
  return norm(dir) === norm(ownDir);
}

export function debugHost(addr) {
  if (!addr || addr === "0.0.0.0" || addr === "::") return "127.0.0.1";
  if (addr === "localhost" || addr === "127.0.0.1" || addr === "::1") return "127.0.0.1";
  return null;
}

export function isMusePage(page) {
  if (page?.type && page.type !== "page") return false;
  try {
    const host = new URL(page.url).hostname;
    return host === "muse.ai" || host === "www.muse.ai";
  } catch {
    return false;
  }
}

export function pickMuseTarget(pages, defaultContextId) {
  const musePages = (pages || []).filter(isMusePage);
  if (!defaultContextId) return { ok: false, code: "context-unknown" };
  const normal = musePages.filter((page) => page.browserContextId === defaultContextId);
  const incognito = musePages.filter(
    (page) => page.browserContextId && page.browserContextId !== defaultContextId,
  );
  if (normal.length === 1) return { ok: true, target: normal[0] };
  if (normal.length > 1) return { ok: false, code: "multiple-tabs" };
  if (incognito.length) return { ok: false, code: "incognito-only" };
  return { ok: false, code: "no-tab" };
}

export function parseTrace(text) {
  const fields = {};
  for (const line of String(text || "").split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return { ip: fields.ip || "", loc: fields.loc || "" };
}

export function vpnGate({ tabIp, hostIp, tabCountry, hostCountry, requireCountry }) {
  const tab = tabCountry || "";
  const machine = hostCountry || "";
  if (!tabIp || !hostIp) {
    return {
      ok: false,
      routing: false,
      tabCountry: tab,
      machineCountry: machine,
      reason:
        "Could not confirm this Muse tab's exit, so the VPN extension is treated as off.",
    };
  }
  if (!tab || !machine || tab.toUpperCase() === machine.toUpperCase()) {
    return {
      ok: false,
      routing: false,
      tabCountry: tab,
      machineCountry: machine,
      reason: `This Muse tab still exits in ${tab || "an unknown country"}, the same country as this Mac. The VPN extension is not routing this tab.`,
    };
  }
  if (requireCountry && tab.toUpperCase() !== String(requireCountry).toUpperCase()) {
    return {
      ok: false,
      routing: true,
      tabCountry: tab,
      machineCountry: machine,
      reason: `The VPN extension is routing this tab via ${tab}, which is not the required country ${requireCountry}.`,
    };
  }
  return { ok: true, routing: true, tabCountry: tab, machineCountry: machine, reason: "" };
}

export function countLiteral(haystack, needle) {
  const text = String(haystack || "");
  const piece = String(needle || "");
  if (!piece) return 0;
  let count = 0;
  let index = 0;
  while (index <= text.length) {
    const found = text.indexOf(piece, index);
    if (found === -1) return count;
    count += 1;
    index = found + piece.length;
  }
  return count;
}

export function extractReply(beforeText, afterText, prompt = "") {
  const before = String(beforeText || "");
  const after = String(afterText || "");
  let added = "";
  if (before && after.startsWith(before)) added = after.slice(before.length);
  else if (prompt) {
    const at = after.lastIndexOf(prompt);
    if (at >= 0) added = after.slice(at + prompt.length);
  }
  const marker = "Assistant message:";
  const markerAt = added.indexOf(marker);
  const body = markerAt >= 0 ? added.slice(markerAt) : added;
  return body
    .split(marker)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/^(You:|User message:)\s*/i, "")
    .trim();
}

export function explainPick(code) {
  switch (code) {
    case "incognito-only":
      return "Muse is only open in incognito. The VPN extension cannot run there. Open muse.ai in a normal window.";
    case "multiple-tabs":
      return "More than one normal Muse tab is open. Leave exactly one.";
    case "context-unknown":
      return "Muse Video Chrome did not identify its normal window.";
    case "no-tab":
      return "No muse.ai tab is open in Muse Video Chrome.";
    default:
      return "The Muse tab is not available.";
  }
}
