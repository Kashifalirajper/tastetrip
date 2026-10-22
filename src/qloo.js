// Qloo access layer: starts the local `qloo mcp` server from @qloo/qloo-harness
// and exposes its tools. The Qloo key only ever lives in the server environment
// (QLOO_API_KEY); the browser never talks to Qloo directly.
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mockCallTool, MOCK_TOOLS } from "./mock.js";

const require = createRequire(import.meta.url);

// Tools the trip agent is allowed to use. All are read-only Qloo workflows.
export const AGENT_TOOLS = [
  "qloo_find_tags",
  "qloo_describe",
  "qloo_recommend",
  "qloo_rank",
  "qloo_where_popular",
  "qloo_entity_tags",
];

const MOCK = process.env.MOCK_QLOO === "1";

function harnessBin() {
  // Resolve the locally installed harness so we don't depend on a global install.
  // The package's exports map hides package.json, so look for the bin file directly.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, "..", "node_modules", "@qloo", "qloo-harness", "dist", "bin.js");
  if (existsSync(candidate)) return candidate;
  try {
    const entry = require.resolve("@qloo/qloo-harness");
    const bin = path.join(path.dirname(entry), "bin.js");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

let clientPromise = null;
let toolCache = null;

async function connect() {
  const bin = harnessBin();
  const transport = new StdioClientTransport({
    command: bin ? process.execPath : "qloo",
    args: bin ? [bin, "mcp"] : ["mcp"],
    // Forward the full environment so QLOO_API_KEY reaches the server.
    env: process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "tastetrip", version: "1.0.0" });
  await client.connect(transport);
  transport.onclose = () => {
    clientPromise = null;
  };
  return client;
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export async function listAgentTools() {
  if (toolCache) return toolCache;
  if (MOCK) return (toolCache = MOCK_TOOLS.filter((t) => AGENT_TOOLS.includes(t.name)));
  const client = await getClient();
  const { tools } = await client.listTools();
  toolCache = tools.filter((t) => AGENT_TOOLS.includes(t.name));
  return toolCache;
}

export async function readiness() {
  if (MOCK) return { ready: true, mode: "mock" };
  try {
    const client = await getClient();
    const res = await client.callTool({ name: "qloo_capabilities", arguments: {} });
    return { ready: Boolean(res.structuredContent?.adapter?.ready), mode: "live" };
  } catch (err) {
    return { ready: false, mode: "live", error: err.message };
  }
}

// Small in-memory cache so repeated demo runs don't burn the event quota.
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const CACHE_MAX = 500;

export async function callQloo(name, args) {
  if (!AGENT_TOOLS.includes(name)) {
    return { status: "error", summary: `Tool ${name} is not allowed.`, results: [], result_count: 0 };
  }
  const key = `${name}:${JSON.stringify(args)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  let envelope;
  if (MOCK) {
    envelope = mockCallTool(name, args);
  } else {
    const client = await getClient();
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
    envelope = res.structuredContent ?? {
      status: res.isError ? "error" : "ok",
      summary: res.content?.map((c) => c.text).join("\n") ?? "",
      results: [],
      result_count: 0,
    };
  }

  if (envelope.status !== "error") {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value: envelope });
  }
  return envelope;
}
