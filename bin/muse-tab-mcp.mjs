#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "muse-tab.mjs");

const tools = [
  {
    name: "send",
    description:
      "Generate one video through the separate Muse Chrome. Connects the VPN before opening Muse, saves only the new mp4, then closes the Muse page and disconnects the VPN. Do not open muse.ai yourself.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The video prompt." },
        wait: { type: "integer", minimum: 1, default: 180, description: "Seconds to wait for the mp4." },
        download: { type: "boolean", default: true, description: "Save the new mp4." },
        out: { type: "string", description: "Directory for the mp4. Defaults to ./muse-out from the agent cwd." },
        country: { type: "string", description: "Required VPN exit country. Set only when the owner named one." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "status",
    description: "Look at the separate Muse Chrome without opening Muse or starting the VPN.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "latest",
    description: "Read the open Muse page without opening Muse or starting the VPN.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  sendMessage({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function toolResult(payload, isError) {
  return { content: [{ type: "text", text: payload }], isError };
}

async function callTool(name, args) {
  if (name === "status") {
    const ran = await runCli(["status", "--json"]);
    return toolResult(ran.stdout || ran.stderr, ran.code !== 0 && !ran.stdout);
  }
  if (name === "latest") {
    const ran = await runCli(["latest", "--json"]);
    return toolResult(ran.stdout || ran.stderr, ran.code !== 0);
  }
  if (name !== "send") return toolResult(`Unknown tool ${name}`, true);
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return toolResult("prompt is required", true);
  const cliArgs = ["send", "--prompt", prompt, "--json", "--wait", String(args.wait || 180)];
  if (args.download !== false) cliArgs.push("--download");
  if (args.out) cliArgs.push("--out", String(args.out));
  if (args.country) cliArgs.push("--country", String(args.country));
  const ran = await runCli(cliArgs);
  const text = ran.stdout || ran.stderr;
  return toolResult(text, ran.code !== 0);
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "muse-tab", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools });
    return;
  }
  if (message.method === "tools/call") {
    const value = await callTool(message.params?.name, message.params?.arguments || {});
    result(message.id, value);
    return;
  }
  failure(message.id, -32601, `Unknown method ${message.method || ""}`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.length) {
    if (buffer.startsWith("Content-Length:")) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const match = buffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
      const start = headerEnd + 4;
      const length = match ? Number(match[1]) : 0;
      if (buffer.length < start + length) return;
      const body = buffer.slice(start, start + length);
      buffer = buffer.slice(start + length);
      handle(JSON.parse(body)).catch((error) => process.stderr.write(`${error.message}\n`));
      continue;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    handle(JSON.parse(line)).catch((error) => process.stderr.write(`${error.message}\n`));
  }
});
