# TasteTrip — trips planned around your taste

TasteTrip is an AI travel agent that turns what you love (artists, films, books, food, vibe) into a day-by-day city itinerary. It is built for the **Qloo Agentic Hackathon**.

A plain LLM trip planner guesses from popularity and its training data. TasteTrip's agent has to ask **Qloo's taste graph** where people who share your tastes actually go in that city. **Every stop in the plan must come from a live Qloo result.** The app checks each stop against those results and shows its Qloo affinity score. Any stop Qloo did not return is flagged.

- **Live demo:** _add your Render URL here_
- **License:** MIT

## What it does

1. **You describe your taste.** For example: "Radiohead, Khruangbin · Lost in Translation · Murakami · ramen, specialty coffee · late-night, record stores", plus a destination and trip length.
2. **The agent plans with Qloo.** A Google Gemini agent is given Qloo's MCP tools and decides which to call:
   - `qloo_find_tags` turns vibe and food words ("speakeasy", "vegan") into Qloo tag URNs.
   - `qloo_recommend` (target `place`, filtered to the destination) finds restaurants, bars, venues, museums and shops with high affinity to your favorites. It runs one call per need: dining, nightlife/music, culture.
   - `qloo_where_popular` finds neighborhoods where your favorite artist or film over-indexes, which gives a "stay near" suggestion.
   - `qloo_rank` orders a shortlist against your taste profile.
3. **Grounding check.** The server keeps a registry of every place Qloo returned in that run. Each stop in the model's plan is matched against it and gets its Qloo entity ID, affinity and address. Unmatched stops are labelled **"Not verified by Qloo"**, and the plan header shows "N of M stops verified".
4. **Transparent evidence.** The UI streams each Qloo call as it happens: tool, arguments, status, and top results with affinity. The "How Qloo shaped this trip" panel keeps the full trail.

### Why Qloo is the differentiator

Without Qloo, the agent has no way to know that fans of a given indie band over-index at a specific jazz kissa in Shimokitazawa rather than at the top-10 tourist list. Qloo's taste graph (250M+ entities across music, film, books, dining and travel) is the only source of picks. The LLM orchestrates the calls and writes the explanations. It is not allowed to invent places.

## Architecture

```
Browser (static HTML/JS)
   │  POST /api/plan  ← Server-Sent Events stream (status, tool calls, plan)
   ▼
Node.js / Express  ──  Gemini (function calling)
   │                        │ tool calls
   ▼                        ▼
@modelcontextprotocol/sdk client ── stdio ── `qloo mcp` (@qloo/qloo-harness)
                                                 │ QLOO_API_KEY (server only)
                                                 ▼
                                             Qloo Taste AI API
```

- `src/qloo.js` starts `qloo mcp` from the official `@qloo/qloo-harness` package, limits the agent to read-only workflows, and caches results to respect the event quota.
- `src/agent.js` runs the Gemini tool-use loop, compacts Qloo results for the model, and does the grounding check.
- `server.js` handles input validation, per-IP rate limiting, a concurrency cap and SSE streaming.
- `public/` is a dependency-free front end with light/dark themes and a mobile layout.

The Qloo key never reaches the browser. Only taste inputs (no names, emails or other personal data) are sent to Qloo.

## Run locally

Requirements: Node.js **22.19+**, a Qloo hackathon API key, and a [Gemini API key](https://aistudio.google.com/apikey).

```sh
git clone https://github.com/Kashifalirajper/tastetrip.git
cd tastetrip
npm install
export QLOO_API_KEY=...      # event credential, keep it out of git
export GEMINI_API_KEY=...
npm start                    # http://localhost:3000
```

To try the UI with no keys at all, use offline mock data:

```sh
npm run mock
```

Run tests with `npm test`.

## Deploy (Render, Docker)

Qloo's MCP server is a local stdio process, so TasteTrip runs as a long-lived container. Serverless functions are not supported.

1. Fork or push this repo to GitHub.
2. In Render, choose **New → Blueprint** (uses `render.yaml`) or **New → Web Service → Docker**.
3. Set the secret environment variables `QLOO_API_KEY` and `GEMINI_API_KEY`.
4. Deploy. The health check is at `/api/health`.

The same `Dockerfile` works on Railway, Fly.io or any VM.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `QLOO_API_KEY` | (required) | Qloo hackathon credential (server only) |
| `GEMINI_API_KEY` | (required) | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model used by the agent |
| `PLANS_PER_HOUR` | `12` | Per-IP rate limit |
| `MAX_CONCURRENT_PLANS` | `4` | Concurrent agent runs |
| `MAX_TOOL_CALLS` | `14` | Qloo call budget per plan |

## Limitations

- Qloo affinities describe **aggregate** audience tastes, not any one person. A high score means "people who like what you like tend to like this", not a guarantee.
- Coverage depends on Qloo's place data for the destination. Smaller towns may return fewer places, and the plan will then be shorter.
- Opening hours, bookings and travel times are not checked. Use the map links to confirm before you go.
- Name matching between the model's plan and Qloo results is fuzzy. A rare mismatch shows as "Not verified", never as a false "From Qloo".

## License

[MIT](LICENSE) © 2026 Kashif Ali
