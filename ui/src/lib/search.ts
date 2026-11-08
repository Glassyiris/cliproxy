export function matchesWords(fields: readonly (string | null | undefined)[], search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fields.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}
