import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planTrip } from "./src/agent.js";
import { readiness } from "./src/qloo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// Simple per-IP rate limit to protect the event quota.
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = Number(process.env.PLANS_PER_HOUR || 12);
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= LIMIT) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

let active = 0;
const MAX_ACTIVE = Number(process.env.MAX_CONCURRENT_PLANS || 4);

const clean = (v, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");

app.get("/api/health", async (_req, res) => {
  const q = await readiness();
  res.json({
    ok: true,
    qloo: q,
    llm: process.env.MOCK_LLM === "1" ? "mock" : Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  });
});

app.post("/api/plan", async (req, res) => {
  const body = req.body ?? {};
  const input = {
    destination: clean(body.destination, 80),
    days: Math.min(Math.max(parseInt(body.days, 10) || 2, 1), 5),
    music: clean(body.music),
    film: clean(body.film),
    books: clean(body.books),
    food: clean(body.food),
    vibe: clean(body.vibe),
    budget: clean(body.budget, 30),
  };
  if (!input.destination) return res.status(400).json({ error: "Please enter a destination city." });
  if (!input.music && !input.film && !input.books && !input.food) {
    return res.status(400).json({ error: "Add at least one favorite (music, film/TV, books or food)." });
  }
  if (rateLimited(req.ip)) return res.status(429).json({ error: "You've planned a lot of trips this hour. Please try again later." });
  if (active >= MAX_ACTIVE) return res.status(503).json({ error: "The agent is busy right now. Please try again in a minute." });

  active++;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  res.on("close", () => (closed = true));
  const emit = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => !closed && res.write(": ping\n\n"), 15000);

  try {
    const plan = await planTrip(input, emit);
    emit("plan", plan);
  } catch (err) {
    console.error("plan failed:", err);
    const msg = /api key|API_KEY|permission|401|403/i.test(err.message)
      ? "The server's API credentials are not working. Please try again later."
      : err.message || "Something went wrong.";
    emit("error", { message: msg });
  } finally {
    clearInterval(ping);
    active--;
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`TasteTrip listening on http://localhost:${PORT}`);
});
