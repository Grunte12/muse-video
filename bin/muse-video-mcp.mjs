#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "muse-video.mjs");

const tools = [
  {
    name: "send",
    description:
      "Muse Video: generate one video through the separate Muse Chrome. Requests from every agent share one queue and run one at a time on one Muse tab. The VPN connects before Muse opens, stays on while the queue has work, and disconnects when the queue is empty. Do not open muse.ai yourself.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the video should do." },
        mode: {
          type: "string",
          enum: ["text-to-video", "frame-to-video", "reference-to-video"],
          default: "text-to-video",
          description: "text-to-video uses the prompt only. frame-to-video uses firstFrame and an optional lastFrame. reference-to-video uses references. One reference image is not a start frame.",
        },
        firstFrame: { type: "string", description: "Start frame image path. Required for frame-to-video." },
        lastFrame: { type: "string", description: "End frame image path. Optional for frame-to-video." },
        references: {
          type: "array",
          items: { type: "string" },
          description: "Reference image paths for reference-to-video. One image is allowed. These are not start or end frames.",
        },
        wait: { type: "integer", minimum: 1, default: 180, description: "Seconds to wait for the mp4." },
        download: { type: "boolean", default: true, description: "Save the new mp4." },
        out: { type: "string", description: "Directory for the mp4. Defaults to ./muse-out from the agent cwd." },
        country: { type: "string", description: "Required VPN exit country. Set only when the owner named one." },
        queueWait: {
          type: "integer",
          minimum: 1,
          default: 600,
          description: "Seconds to wait for earlier jobs to finish before this one starts.",
        },
      },
      required: ["prompt"],
      // snake_case names (first_frame, queue_wait, job_id) are accepted too.
      additionalProperties: true,
    },
  },
  {
    name: "status",
    description: "Muse Video: look at the queue and the separate Muse Chrome without opening Muse or starting the VPN.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "latest",
    description: "Muse Video: read the open Muse page without opening Muse or starting the VPN. Pass jobId to read that queued job's tab.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id returned by send. Omit it when only one Muse tab is open." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "jobs",
    description: "Muse Video: list saved logs of past jobs (state, prompt, files). Pass jobId for one job. Does not open Muse.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        limit: { type: "integer", minimum: 1, default: 20 },
      },
      additionalProperties: true,
    },
  },
  {
    name: "collect",
    description:
      "Muse Video: download the newest clip from an already open Muse tab without sending a prompt. Clips saved before are skipped by hash, so an old video is never returned as new. Use it after a send timed out or when the clip finished late.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id from send or jobs. Picks that job's tab and output folder." },
        out: { type: "string", description: "Directory for the mp4." },
      },
      additionalProperties: true,
    },
  },
];

function normalizeArgs(args) {
  const out = { ...args };
  for (const key of Object.keys(args)) {
    const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (camel !== key && out[camel] === undefined) out[camel] = args[key];
  }
  return out;
}

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  sendMessage({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

const children = new Set();

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      children.delete(child);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function stopChildren() {
  for (const child of children) child.kill("SIGTERM");
}

function toolResult(payload, isError) {
  return { content: [{ type: "text", text: payload }], isError };
}

async function callTool(name, rawArgs) {
  const args = normalizeArgs(rawArgs || {});
  if (name === "jobs") {
    const cliArgs = ["jobs", "--json"];
    if (args.jobId) cliArgs.push("--job", String(args.jobId));
    if (args.limit) cliArgs.push("--limit", String(args.limit));
    const ran = await runCli(cliArgs);
    return toolResult(ran.stdout || ran.stderr, ran.code !== 0 && !ran.stdout);
  }
  if (name === "collect") {
    const cliArgs = ["collect", "--json"];
    if (args.jobId) cliArgs.push("--job", String(args.jobId));
    if (args.out) cliArgs.push("--out", String(args.out));
    const ran = await runCli(cliArgs);
    return toolResult(ran.stdout || ran.stderr, ran.code !== 0 && !ran.stdout);
  }
  if (name === "status") {
    const ran = await runCli(["status", "--json"]);
    return toolResult(ran.stdout || ran.stderr, ran.code !== 0 && !ran.stdout);
  }
  if (name === "latest") {
    const cliArgs = ["latest", "--json"];
    if (args.jobId) cliArgs.push("--job", String(args.jobId));
    const ran = await runCli(cliArgs);
    return toolResult(ran.stdout || ran.stderr, ran.code !== 0);
  }
  if (name !== "send") return toolResult(`Unknown tool ${name}`, true);
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return toolResult("prompt is required", true);
  const cliArgs = ["send", "--prompt", prompt, "--json", "--wait", String(args.wait || 180), "--mode", String(args.mode || "text-to-video")];
  if (args.firstFrame) cliArgs.push("--first-frame", String(args.firstFrame));
  if (args.lastFrame) cliArgs.push("--last-frame", String(args.lastFrame));
  for (const reference of args.references || []) cliArgs.push("--reference", String(reference));
  if (args.download !== false) cliArgs.push("--download");
  if (args.out) cliArgs.push("--out", String(args.out));
  if (args.country) cliArgs.push("--country", String(args.country));
  if (args.queueWait) cliArgs.push("--queue-wait", String(args.queueWait));
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
      serverInfo: { name: "Muse Video", version: "1.1.0" },
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
process.stdin.on("end", stopChildren);
process.stdin.on("close", stopChildren);
