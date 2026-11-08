import { Fragment } from "react";
import { Text } from "@astryxdesign/core/Text";
import { wordUnits } from "../lib/words.ts";

/**
 * A reset or recovery line inside the text around it, wrapping only between whole words (see
 * `wordUnits`): zh-TW split 「20 小時 21 分鐘後重設」 inside 重設 at a narrow column. Each unit
 * is a no-wrap Text, as `Identifier` does for its pieces.
 */
export function Words({ children }: { children: string }) {
  return wordUnits(children).map((unit, i) => (
    <Fragment key={i}>
      {unit.spaced ? " " : i > 0 && <wbr />}
      <Text type="inherit" color="inherit" textWrap="nowrap">
        {unit.text}
      </Text>
    </Fragment>
  ));
}
