// Scripted stand-in for the LLM, used only for offline development
// (MOCK_LLM=1). It exercises the same tool + grounding path as the real agent.
import { callQloo } from "./qloo.js";
import { groundPlan } from "./agent.js";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function mockPlan(input, emit) {
  const signals = [input.music, input.film, input.books].filter(Boolean).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const registry = new Map();
  const run = async (tool, args) => {
    emit("tool_call", { tool, args });
    const env = await callQloo(tool, args);
    for (const r of env.results ?? []) registry.set(norm(r.name), { entity_id: r.entity_id ?? null, affinity: r.affinity ?? null, popularity: r.popularity ?? null, address: r.properties?.address ?? null, source_tool: tool });
    emit("tool_result", { tool, args, status: env.status, summary: env.summary, result_count: env.result_count, top: (env.results ?? []).slice(0, 6).map((r) => ({ name: r.name, affinity: r.affinity })), requests: env.provenance?.requests ?? [] });
    return env;
  };
  emit("status", { message: "Mock agent running…" });
  const [dining, culture] = await Promise.all([
    run("qloo_recommend", { target_type: "place", signals, filter_location: input.destination, include_tags: ["restaurant"], limit: 8 }),
    run("qloo_recommend", { target_type: "place", signals, filter_location: input.destination, include_tags: ["music venue"], limit: 8 }),
  ]);
  const d = dining.results ?? [], c = culture.results ?? [];
  if (!d.length || !c.length) throw new Error(dining.summary || culture.summary || "Qloo returned no places.");
  const days = Array.from({ length: Number(input.days) || 1 }, (_, i) => ({
    day: i + 1,
    theme: i % 2 ? "Late nights and live music" : "Slow mornings, big flavors",
    stops: [
      { time: "Morning", name: c[i % c.length].name, category: "Culture", why: "Fits your taste profile." },
      { time: "Lunch", name: d[i % d.length].name, category: "Dining", why: "High Qloo affinity with your favorites." },
      { time: "Evening", name: c[(i + 1) % c.length].name, category: "Live music", why: "Fans of your artists over-index here." },
      { time: "Late night", name: "Invented Bar That Qloo Never Returned", category: "Bar", why: "Should be flagged as unverified." },
    ],
  }));
  return groundPlan(
    {
      title: `${input.days}-day taste trip to ${input.destination}`,
      summary: "Mock plan generated offline to exercise the UI and grounding checks.",
      taste_profile: ["indie", "late-night", "street food"],
      base_neighborhood: { name: "Mock Old Town", why: "Your favorite artist over-indexes here." },
      days,
      limitations: ["Mock data — not real places."],
    },
    registry,
  );
}
