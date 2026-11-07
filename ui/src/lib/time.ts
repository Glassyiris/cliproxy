/** Durations like 45s, 4m, 2h 5m, 3d. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
export function ago(value: unknown, now = Date.now()): string {
  const t = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (Number.isNaN(t) || t <= 0) return "";
  return now - t < 45_000 ? "just now" : `${span(now - t)} ago`;
}
