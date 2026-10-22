// Offline mock of the Qloo MCP tools. Used only for local UI development and
// tests (MOCK_QLOO=1). The deployed demo always calls the real Qloo API.
const schema = (properties, required = []) => ({ type: "object", properties, required });
const list = { type: "array", items: { type: "string" } };

export const MOCK_TOOLS = [
  { name: "qloo_find_tags", description: "Search Qloo's tag ontology.", inputSchema: schema({ query: { type: "string" }, limit: { type: "integer" } }, ["query"]) },
  { name: "qloo_describe", description: "Resolve one named entity.", inputSchema: schema({ entity: { type: "string" }, type: { type: "string" } }, ["entity"]) },
  {
    name: "qloo_recommend",
    description: "Find Qloo entities related to a taste profile.",
    inputSchema: schema(
      { target_type: { type: "string" }, signals: list, signal_tags: list, filter_location: { type: "string" }, include_tags: list, limit: { type: "integer" } },
      ["target_type"],
    ),
  },
  { name: "qloo_rank", description: "Rank options.", inputSchema: schema({ options: list, option_type: { type: "string" }, signals: list }, ["options", "option_type"]) },
  { name: "qloo_where_popular", description: "Where an entity is popular.", inputSchema: schema({ entity: { type: "string" }, within: { type: "string" } }, ["entity", "within"]) },
  { name: "qloo_entity_tags", description: "Tags for entities.", inputSchema: schema({ entities: list }, ["entities"]) },
];

const PLACES = {
  dining: [
    ["Mock Ramen Bar", "12 Example St", 0.94],
    ["Mock Vinyl Café", "3 Sample Ave", 0.91],
    ["Mock Night Market", "77 Placeholder Rd", 0.88],
    ["Mock Bistro", "8 Demo Lane", 0.84],
  ],
  culture: [
    ["Mock Jazz Club", "21 Example Sq", 0.93],
    ["Mock Film Archive", "5 Sample Blvd", 0.9],
    ["Mock Record Store", "40 Demo St", 0.87],
    ["Mock Art Museum", "1 Gallery Way", 0.82],
  ],
};

let n = 0;
const envelope = (operation, results, summary) => ({
  schema_version: "1.0-preview.1",
  operation,
  status: results.length ? "ok" : "empty",
  summary,
  results,
  result_count: results.length,
  provenance: { source: "mock", endpoint: "/v2/insights", documentation: "https://docs.qloo.com", requests: [{ method: "GET", path: "/v2/insights", query: { mock: true } }] },
  execution: { transport: "mcp", transport_name: "mock", correlation_id: `mock-${++n}`, duration_ms: 5 },
});

export function mockCallTool(name, args = {}) {
  if (name === "qloo_find_tags") {
    return envelope("find_tags", [{ id: `urn:tag:genre:place:${String(args.query).replace(/\W+/g, "_")}`, name: args.query, type: "urn:tag:genre:place" }], `Found tags for ${args.query}.`);
  }
  if (name === "qloo_recommend") {
    const tags = (args.include_tags ?? []).join(" ").toLowerCase();
    const bucket = /restaurant|food|dining|cafe|coffee/.test(tags) ? PLACES.dining : PLACES.culture;
    const results = bucket.map(([nm, address, affinity], i) => ({
      entity_id: `mock-${nm.replace(/\W+/g, "-").toLowerCase()}`,
      name: nm,
      type: "urn:entity",
      subtype: "urn:entity:place",
      affinity,
      popularity: 0.8 - i * 0.05,
      properties: { address: `${address}, ${args.filter_location ?? "Somewhere"}`, business_rating: 4.5 },
    }));
    return envelope("recommend", results, `Mock places for ${args.signals?.join(", ") ?? "profile"}.`);
  }
  if (name === "qloo_where_popular") {
    return envelope("where_popular", [{ name: "Mock Old Town", affinity: 0.9 }, { name: "Mock Riverside", affinity: 0.8 }], `Areas where ${args.entity} is popular.`);
  }
  if (name === "qloo_rank") {
    return envelope("rank", (args.options ?? []).map((o, i) => ({ name: o, affinity: 0.9 - i * 0.1 })), "Ranked options.");
  }
  if (name === "qloo_describe") {
    return envelope("describe", [{ name: args.entity, entity_id: "mock-id", type: "urn:entity" }], `Described ${args.entity}.`);
  }
  if (name === "qloo_entity_tags") {
    return envelope("entity_tags", [{ name: "indie", id: "urn:tag:genre:indie", affinity: 0.9 }], "Tags.");
  }
  return envelope(name.replace(/^qloo_/, ""), [], "No mock.");
}
