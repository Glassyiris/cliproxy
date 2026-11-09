/** One unit of a line that must not break inside, and whether a space comes before it. */
type WordUnit = { text: string; spaced: boolean };

// A Chinese run breaks before a number ("20小时21分钟" before "21"), never after a Latin letter or
// inside a number ("HTTP2", "14:20", "1.5").
const BEFORE_NUMBER = /(?<=[^\d.,:/%A-Za-z])(?=\d)/u;
const NUMBER = /^\d+([.,:]\d+)*$/;

/**
 * A short line (a reset or recovery time) cut where it may wrap: at its spaces and before a number,
 * with a bare number kept with the word after it ("20 小時"). A Chinese word such as 重設 or
 * 分鐘後 then never splits; CSS alone cannot say so, since `keep-all` makes "20小时21分钟后重置"
 * one unbreakable run that overflows, and the overflow then breaks it anywhere.
 */
export function wordUnits(line: string): WordUnit[] {
  const units: WordUnit[] = [];
  let glue = false;
  for (const word of line.split(/\s+/).filter(Boolean)) {
    const pieces = word.split(BEFORE_NUMBER);
    pieces.forEach((piece, i) => {
      const last = units.at(-1);
      if (glue && last && i === 0) last.text += ` ${piece}`;
      else units.push({ text: piece, spaced: i === 0 && units.length > 0 });
    });
    glue = NUMBER.test(pieces.at(-1) ?? "");
  }
  return units;
}
