// How a TrafficStrip bucket is coloured by the share of its requests that failed (OPEN-QUESTIONS
// 12): a stray failure in a busy bucket stays neutral, a real fraction is a warning, and a bucket
// where at least half failed is an error.

/** From this share of failed requests a bucket is degraded (warning). */
const DEGRADED_SHARE = 0.05;
/** From this share of failed requests a bucket is failing (error). */
const FAILING_SHARE = 0.5;

export type Tone = "neutral" | "degraded" | "failing";

/** The tone of one bucket of `total` requests of which `failed` failed. */
export function bucketTone(total: number, failed: number): Tone {
  if (failed <= 0) return "neutral";
  const share = total > 0 ? failed / total : 1;
  if (share >= FAILING_SHARE) return "failing";
  if (share >= DEGRADED_SHARE) return "degraded";
  return "neutral";
}

/** How many buckets are degraded and how many failing, for the strip's accessible summary. */
export function toneCounts(total: readonly number[], failed: readonly number[]) {
  let degraded = 0;
  let failing = 0;
  total.forEach((n, i) => {
    const tone = bucketTone(n, failed[i] ?? 0);
    if (tone === "degraded") degraded++;
    if (tone === "failing") failing++;
  });
  return { degraded, failing };
}
