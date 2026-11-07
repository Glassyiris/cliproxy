import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanEvent, usageStats } from "./usage.ts";

test("usage events keep display fields only and summarise by model", () => {
  const raw = {
    timestamp: "2026-10-02T11:59:59Z",
    latency_ms: 100,
    ttft_ms: 40,
    failed: true,
    fail: { status_code: 529, body: "upstream said secret things" },
    api_key: "sk-client-secret",
    client_ip: "203.0.113.9",
    user_agent: "tool/1.0",
    model: "claude-sonnet-4-5",
    alias: "daily",
    tokens: { input_tokens: 10, output_tokens: 5 },
  };
  const e = cleanEvent(raw);
  assert.deepEqual(Object.keys(e).sort(), ["at", "auth", "failed", "id", "input", "latency", "model", "output", "provider", "status", "ttft"]);
  assert.equal(JSON.stringify(e).includes("secret"), false);
  assert.deepEqual([e.model, e.status, e.at], ["daily", 529, Date.parse(raw.timestamp)]);
  const s = usageStats([e, cleanEvent({ model: "m", latency_ms: 0 }), cleanEvent({ model: "m", latency_ms: 300, ttft_ms: 0 })]);
  assert.deepEqual([s.count, s.failed, s.latency, s.ttft], [3, 1, 100, 40]);
  assert.deepEqual(s.models.map((m) => [m.model, m.count]), [["m", 2], ["daily", 1]]);
  assert.equal(usageStats([]).latency, null);
});
