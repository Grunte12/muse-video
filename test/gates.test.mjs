import assert from "node:assert/strict";
import test from "node:test";
import {
  debugHost,
  explainPick,
  extractReply,
  countLiteral,
  parseChromeCommand,
  parseTrace,
  pickMuseTarget,
  sameProfile,
  vpnGate,
} from "../lib/gates.mjs";

test("only the Muse Tab Chrome profile matches", () => {
  const own = "/Users/example/.muse-tab/chrome";
  assert.equal(sameProfile(own, own), true);
  assert.equal(sameProfile(`${own}/`, own), true);
  assert.equal(sameProfile("/Users/example/other-chrome", own), false);
});

test("parses the local debugging Chrome and ignores helpers", () => {
  const main =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9341 --user-data-dir=/Users/example/.muse-tab/chrome";
  assert.deepEqual(parseChromeCommand(main), {
    port: 9341,
    dir: "/Users/example/.muse-tab/chrome",
    addr: "127.0.0.1",
  });
  const helper =
    "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --remote-debugging-port=9341 --user-data-dir=/Users/example/.muse-tab/chrome";
  assert.equal(parseChromeCommand(helper), null);
  assert.equal(debugHost("127.0.0.1"), "127.0.0.1");
  assert.equal(debugHost("8.8.8.8"), null);
});

test("selects the normal Muse tab and rejects an incognito-only tab", () => {
  const pages = [
    { type: "page", url: "https://chatgpt.com/", browserContextId: "normal" },
    { type: "page", url: "https://muse.ai/", browserContextId: "incognito", title: "incognito muse" },
    { type: "page", url: "https://muse.ai/", browserContextId: "normal", title: "Chat — Muse" },
  ];
  const picked = pickMuseTarget(pages, "normal");
  assert.equal(picked.ok, true);
  assert.equal(picked.target.title, "Chat — Muse");
  assert.equal(
    pickMuseTarget([{ type: "page", url: "https://muse.ai/", browserContextId: "incognito" }], "normal").code,
    "incognito-only",
  );
  assert.equal(pickMuseTarget([], "normal").code, "no-tab");
  assert.equal(explainPick("incognito-only").includes("incognito"), true);
});

test("vpn gate fails closed when the tab shares the machine address", () => {
  const blocked = vpnGate({
    tabIp: "203.0.113.10",
    hostIp: "203.0.113.10",
    tabCountry: "TH",
    hostCountry: "TH",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.routing, false);
  assert.equal(blocked.reason.includes("203.0.113.10"), false);

  const sameCountry = vpnGate({
    tabIp: "198.51.100.8",
    hostIp: "203.0.113.10",
    tabCountry: "TH",
    hostCountry: "TH",
  });
  assert.equal(sameCountry.ok, false);
  assert.equal(sameCountry.reason.includes("198.51.100.8"), false);

  const routed = vpnGate({
    tabIp: "198.51.100.8",
    hostIp: "203.0.113.10",
    tabCountry: "US",
    hostCountry: "TH",
    requireCountry: "US",
  });
  assert.equal(routed.ok, true);

  const wrongCountry = vpnGate({
    tabIp: "198.51.100.8",
    hostIp: "203.0.113.10",
    tabCountry: "DE",
    hostCountry: "TH",
    requireCountry: "US",
  });
  assert.equal(wrongCountry.ok, false);
  assert.equal(wrongCountry.routing, true);
});

test("trace parser and reply extractor", () => {
  assert.deepEqual(parseTrace("fl=1\nip=203.0.113.5\nloc=TH\n"), {
    ip: "203.0.113.5",
    loc: "TH",
  });
  const before = "older\nUser message: hi\nAssistant message: old reply";
  const after = `${before}\nUser message: make a video\nAssistant message: Here it is\nAssistant message: Want another?`;
  assert.equal(extractReply(before, after, "make a video"), "Here it is\n\nWant another?");
  const shifted = "intro was rewritten\nYou:\n\ndo not send this\n\nGot it.";
  assert.equal(extractReply("unrelated prefix", shifted, "do not send this"), "Got it.");
  assert.equal(countLiteral("one two one", "one"), 2);
});
