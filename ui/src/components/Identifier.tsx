import { Fragment } from "react";
import { Text } from "@astryxdesign/core/Text";
import { roles } from "../themes/site/roles.ts";

/** Where a line may break: an address after `:` or `/`; a file name or email also after `@._-`. */
const BREAKS = {
  address: /[^:/]*[:/]*/g,
  name: /[^:/@._-]*[:/@._-]*/g,
};

/** The pieces of an identifier, each ending in its run of separators. */
const pieces = (value: string, at: keyof typeof BREAKS) =>
  value.match(BREAKS[at])?.filter(Boolean) ?? [value];

/**
 * An identifier (address, header name, file name, email) in the text around it, with no chip and
 * no mono family (owner, 2026-11-08: 「也太難看了」; the code family falls back to a Courier-like
 * face where SF Mono and Consolas are missing), that breaks only after its separators, so an address
 * shows whole on a phone, "x-api-key" never splits, and a file name breaks after `@`, `.`, `-` or
 * `_`, never inside a word. Text alone breaks a long token anywhere, which split "x-api-key" at
 * its hyphen and an address inside its port at 390 px.
 */
export function Identifier({
  children,
  breakAt = "address",
}: {
  children: string;
  breakAt?: keyof typeof BREAKS;
}) {
  return (
    <Text type={roles.textType.nested}>
      {pieces(children, breakAt).map((piece, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          <Text type="inherit" color="inherit" textWrap="nowrap">
            {piece}
          </Text>
        </Fragment>
      ))}
    </Text>
  );
}
