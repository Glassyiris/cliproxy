import { strict as assert } from "node:assert";
import { test } from "node:test";
import { wordUnits } from "./words.ts";

const cut = (line: string) =>
  wordUnits(line)
    .map((u) => (u.spaced ? `␣${u.text}` : u.text))
    .join("|");

test("a reset line wraps only between whole words, a number kept with its unit", () => {
  assert.equal(cut("20 小時 21 分鐘後重設"), "20 小時|␣21 分鐘後重設");
  assert.equal(cut("20小时21分钟后重置"), "20小时|21分钟后重置");
  assert.equal(cut("最早 2小时后恢复"), "最早|␣2小时后恢复");
  assert.equal(
    cut("恢復時間：4 小時 57 分鐘後（週一上午05:57）"),
    "恢復時間：|4 小時|␣57 分鐘後（週一上午|05:57）",
  );
  assert.equal(cut("Resets in 2h 5m"), "Resets|␣in|␣2h|␣5m");
  assert.equal(cut("HTTP 429, 1.5 days"), "HTTP|␣429,|␣1.5 days");
  assert.deepEqual(wordUnits(""), []);
});
