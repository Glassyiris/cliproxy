/** A random client key: "sk-" and 48 hex characters. */
export const newKey = () => `sk-${Array.from(crypto.getRandomValues(new Uint8Array(24)), (n) => n.toString(16).padStart(2, "0")).join("")}`;
export const mask = (k: string) => (k.length > 10 ? `${k.slice(0, 3)}…${k.slice(-4)}` : "••••");
