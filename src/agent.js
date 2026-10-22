// The TasteTrip agent: Gemini plans, Qloo grounds. The model can only pick
// places that come back from Qloo tool calls; every stop in the final plan is
// checked against those results and labelled with its Qloo evidence.
import { GoogleGenAI } from "@google/genai";
import { listAgentTools, callQloo } from "./qloo.js";
import { mockPlan } from "./mock-agent.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_ROUNDS = Number(process.env.MAX_AGENT_ROUNDS || 8);
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS || 14);

const SYSTEM_PROMPT = `You are TasteTrip, a travel-planning agent whose picks are grounded in Qloo's cultural taste graph.

GOAL
Turn a traveler's cultural tastes (music, film/TV, books, food, vibe) into a day-by-day city itinerary of places they are likely to love.

HOW TO WORK (call tools, do not guess)
1. Turn abstract vibe or food words (e.g. "speakeasy", "vegan", "third-wave coffee") into Qloo tags with qloo_find_tags. Use the best clearly matching tag URN; skip a tag if nothing clearly matches.
2. Call qloo_recommend with target_type "place", the traveler's named favorites as "signals", filter_location set to the destination city, and include_tags for the kind of place. Make separate calls for different needs, e.g. dining (restaurants/cafes), nightlife or live music (bars, music venues), and culture or sights (museums, bookstores, record stores, parks). Use limit 8-12.
3. Optionally call qloo_where_popular with one favorite entity and within = destination to find neighborhoods where that taste over-indexes, to suggest a base neighborhood.
4. Optionally use qloo_rank to order a shortlist of places for the traveler's signals.
Make several independent tool calls in parallel when you can. Stay within about ${MAX_TOOL_CALLS} tool calls total.

STRICT GROUNDING RULES
- Every stop in the itinerary MUST be a place returned by a Qloo tool call in this conversation. Copy the place name exactly as Qloo returned it. Never invent or add places from your own knowledge.
- If Qloo returns too few places, make a shorter itinerary and say so in "limitations".
- If a tool returns status "needs_input", pick the clearest candidate yourself if one is obviously right; otherwise drop that signal. If "error", adapt or stop.
- Qloo affinities are aggregate cultural signals, not facts about this person. Do not claim certainty.
- Never ask the user follow-up questions; produce the best plan you can.

FINAL ANSWER
When done, reply with ONLY a JSON object in a \`\`\`json code block, matching:
{
  "title": string,
  "summary": string (2-3 sentences on how their tastes shaped the trip),
  "taste_profile": [string] (3-6 short phrases describing the inferred taste),
  "base_neighborhood": { "name": string, "why": string } | null,
  "days": [ { "day": number, "theme": string, "stops": [ { "time": "Morning|Lunch|Afternoon|Evening|Late night", "name": string, "category": string, "why": string (one sentence tying it to their tastes) } ] } ],
  "limitations": [string]
}
Use 3-5 stops per day.`;

// Gemini accepts JSON Schema for parameters, but drop keys it may reject.
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (["examples", "additionalProperties", "uniqueItems", "$schema", "default"].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Shrink a Qloo envelope before giving it to the model.
function compactForModel(env) {
  const results = Array.isArray(env.results) ? env.results.slice(0, 12) : env.results;
  return {
    status: env.status,
    summary: env.summary,
    warnings: env.warnings,
    error: env.error,
    interpretation: env.interpretation,
    result_count: env.result_count,
    results: Array.isArray(results)
      ? results.map((r) => ({
          name: r.name,
          entity_id: r.entity_id ?? r.id,
          subtype: r.subtype ?? r.type,
          affinity: r.affinity,
          popularity: r.popularity,
          address: r.properties?.address,
          price_level: r.properties?.price_level,
          rating: r.properties?.business_rating,
          description: r.properties?.short_description ?? r.properties?.description?.slice?.(0, 200),
        }))
      : results,
  };
}

// Summary of a tool result for the UI's evidence log.
function evidenceForUI(name, args, env) {
  const items = Array.isArray(env.results) ? env.results : [];
  return {
    tool: name,
    args,
    status: env.status,
    summary: env.summary,
    cached: Boolean(env.cached),
    result_count: env.result_count ?? items.length,
    top: items.slice(0, 6).map((r) => ({ name: r.name, affinity: r.affinity })),
    requests: env.provenance?.requests?.map((r) => ({ method: r.method, path: r.path })) ?? [],
    error: env.error ? { code: env.error.code, recovery: env.error.recovery } : undefined,
  };
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Attach Qloo evidence to each stop and flag anything Qloo did not return.
export function groundPlan(plan, registry) {
  let verified = 0;
  let total = 0;
  for (const day of plan.days ?? []) {
    for (const stop of day.stops ?? []) {
      total++;
      const key = norm(stop.name);
      let hit = registry.get(key);
      if (!hit) {
        for (const [k, v] of registry) {
          if (k.length > 3 && (k.includes(key) || key.includes(k))) {
            hit = v;
            break;
          }
        }
      }
      if (hit) {
        verified++;
        stop.qloo = hit;
      } else {
        stop.qloo = null;
      }
    }
  }
  plan.grounding = { verified, total };
  return plan;
}

function buildUserPrompt(input) {
  const lines = [
    `Destination: ${input.destination}`,
    `Trip length: ${input.days} day(s)`,
  ];
  if (input.music) lines.push(`Favorite music/artists: ${input.music}`);
  if (input.film) lines.push(`Favorite films/TV: ${input.film}`);
  if (input.books) lines.push(`Favorite books/authors: ${input.books}`);
  if (input.food) lines.push(`Food they love: ${input.food}`);
  if (input.vibe) lines.push(`Trip vibe: ${input.vibe}`);
  if (input.budget) lines.push(`Budget: ${input.budget}`);
  lines.push("Plan the trip using Qloo tools, then return the JSON plan.");
  return lines.join("\n");
}

/**
 * Run the agent. `emit(event, data)` streams progress to the client.
 */
export async function planTrip(input, emit) {
  if (process.env.MOCK_LLM === "1") return mockPlan(input, emit);

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");
  const ai = new GoogleGenAI({ apiKey });

  const tools = await listAgentTools();
  const functionDeclarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: cleanSchema(t.inputSchema),
  }));

  const contents = [{ role: "user", parts: [{ text: buildUserPrompt(input) }] }];
  const registry = new Map();
  let toolCalls = 0;

  emit("status", { message: "Agent is reading your tastes…" });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const forceFinish = toolCalls >= MAX_TOOL_CALLS || round === MAX_ROUNDS - 1;
    const res = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.4,
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig: { mode: forceFinish ? "NONE" : "AUTO" } },
      },
    });

    const candidate = res.candidates?.[0];
    if (!candidate?.content) throw new Error("The model returned no content. Please try again.");
    contents.push(candidate.content);

    const calls = res.functionCalls ?? [];
    if (calls.length === 0) {
      const plan = extractJson(res.text);
      if (!plan) {
        if (round < MAX_ROUNDS - 1) {
          contents.push({ role: "user", parts: [{ text: "Return the final plan now as the JSON object described, in a ```json block." }] });
          continue;
        }
        throw new Error("The agent could not produce a plan. Please try again.");
      }
      if (registry.size === 0) {
        throw new Error("Qloo didn't return any places for this destination and taste mix. Try a bigger city or different favorites.");
      }
      return groundPlan(plan, registry);
    }

    emit("status", { message: `Querying Qloo (${calls.length} call${calls.length > 1 ? "s" : ""})…` });
    const responses = await Promise.all(
      calls.map(async (call) => {
        toolCalls++;
        emit("tool_call", { tool: call.name, args: call.args });
        let env;
        try {
          env = await callQloo(call.name, call.args ?? {});
        } catch (err) {
          env = { status: "error", summary: err.message, results: [], result_count: 0, error: { code: "CLIENT", retryable: false, recovery: "Try different inputs." } };
        }
        if (Array.isArray(env.results)) {
          for (const r of env.results) {
            if (!r?.name) continue;
            const isPlace = call.name === "qloo_recommend" || call.name === "qloo_rank";
            if (!isPlace) continue;
            registry.set(norm(r.name), {
              entity_id: r.entity_id ?? r.id ?? null,
              affinity: typeof r.affinity === "number" ? r.affinity : null,
              popularity: typeof r.popularity === "number" ? r.popularity : null,
              address: r.properties?.address ?? null,
              source_tool: call.name,
            });
          }
        }
        emit("tool_result", evidenceForUI(call.name, call.args, env));
        return {
          functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: compactForModel(env) },
        };
      }),
    );
    contents.push({ role: "user", parts: responses });
  }
  throw new Error("The agent ran out of steps before finishing.");
}
