import { sum } from "./credentials.ts";
import type { Data } from "./json.ts";

// Usage records also carry client keys, IPs, and response bodies. Keep display fields only.
export type UsageEvent = {
  at: number;
  latency: number;
  ttft: number;
  failed: boolean;
  status: number;
  model: string;
  provider: string;
  auth: string;
  id: string;
  input: number;
  output: number;
};
type UsageRecord = Data & {
  alias?: string;
  model?: string;
  provider?: string;
  auth_index?: string;
  request_id?: string;
};

export function cleanEvent(raw: UsageRecord): UsageEvent {
  const t = Date.parse(String(raw.timestamp));
  return {
    at: Number.isNaN(t) ? Date.now() : t,
    latency: Number(raw.latency_ms) || 0,
    ttft: Number(raw.ttft_ms) || 0,
    failed: raw.failed === true,
    status: Number((raw.fail as Data | undefined)?.status_code) || (raw.failed === true ? 0 : 200),
    model: String(raw.alias || raw.model || "unknown"),
    provider: String(raw.provider || "unknown"),
    auth: String(raw.auth_index || ""),
    id: String(raw.request_id || ""),
    input: Number((raw.tokens as Data | undefined)?.input_tokens) || 0,
    output: Number((raw.tokens as Data | undefined)?.output_tokens) || 0,
  };
}
const median = (v: number[]) => {
  const s = v.filter((n) => n > 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
export function usageStats(events: UsageEvent[]) {
  const models = new Map<
    string,
    { model: string; count: number; failed: number; input: number; output: number }
  >();
  for (const e of events) {
    const m = models.get(e.model) || { model: e.model, count: 0, failed: 0, input: 0, output: 0 };
    m.count++;
    m.failed += +e.failed;
    m.input += e.input;
    m.output += e.output;
    models.set(e.model, m);
  }
  return {
    count: events.length,
    failed: events.filter((e) => e.failed).length,
    latency: median(events.map((e) => e.latency)),
    ttft: median(events.map((e) => e.ttft)),
    input: sum(events.map((e) => e.input)),
    output: sum(events.map((e) => e.output)),
    models: [...models.values()].sort((a, b) => b.count - a.count),
  };
}
