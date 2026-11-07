// X-CPA-VERSION reads "cliproxy-rs-1.2.3"; a release tag reads "v1.2.3".
const bare = (version: string) => version.replace(/^cliproxy-rs[/-]/, "").replace(/^v/, "");

const parts = (version: string) => {
  const value = bare(version);
  return /^\d+(\.\d+)*$/.test(value) ? value.split(".").map(Number) : null;
};

/**
 * How the latest release tag relates to the version this server reports. "unknown" when either
 * side is missing or not a dotted number, such as a pre-release or a development build.
 */
export function releaseStatus(latest: string, server: string): "available" | "current" | "unknown" {
  const release = parts(latest);
  const running = parts(server);
  if (!release || !running) return "unknown";
  for (let i = 0; i < Math.max(release.length, running.length); i++) {
    const diff = (release[i] ?? 0) - (running[i] ?? 0);
    if (diff) return diff > 0 ? "available" : "current";
  }
  return "current";
}
