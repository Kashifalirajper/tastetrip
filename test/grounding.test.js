import { test } from "node:test";
import assert from "node:assert/strict";
import { groundPlan } from "../src/agent.js";

test("stops returned by Qloo are verified, invented ones are flagged", () => {
  const registry = new Map([["cafe de flore", { entity_id: "x", affinity: 0.9, address: "Paris", source_tool: "qloo_recommend" }]]);
  const plan = groundPlan(
    { days: [{ day: 1, stops: [{ name: "Café de Flore" }, { name: "Made Up Place" }] }] },
    registry,
  );
  assert.equal(plan.days[0].stops[0].qloo.entity_id, "x");
  assert.equal(plan.days[0].stops[1].qloo, null);
  assert.deepEqual(plan.grounding, { verified: 1, total: 2 });
});
