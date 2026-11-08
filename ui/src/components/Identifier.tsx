import { Fragment } from "react";
import { Code } from "@astryxdesign/core/Code";
import { Text } from "@astryxdesign/core/Text";

/** The pieces of an identifier, each ending in its run of `:` or `/` separators. */
const pieces = (value: string) => value.match(/[^:/]*[:/]*/g)?.filter(Boolean) ?? [value];

/**
 * An identifier (address, header name) as a Code chip that breaks only after `:` or `/`, so an
 * address shows whole on a phone and "x-api-key" never splits. Code alone breaks a long token
 * anywhere, which split "x-api-key" at its hyphen and an address inside its port at 390 px.
 */
export function Identifier({ children }: { children: string }) {
  return (
    <Code>
      {pieces(children).map((piece, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          <Text type="inherit" color="inherit" textWrap="nowrap">
            {piece}
          </Text>
        </Fragment>
      ))}
    </Code>
  );
}
