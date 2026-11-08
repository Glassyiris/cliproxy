import * as stylex from "@stylexjs/stylex";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { roles } from "../../themes/site/roles.ts";

const styles = stylex.create({
  keep: { flexShrink: 0 },
  give: { flexShrink: 1, minWidth: 0 },
});

/**
 * One line of body text cut in the middle: `head` gives way with an ellipsis, `tail` (an
 * endpoint's last path segment, a key's last characters) always shows, and the whole value is in
 * the tooltip. Both parts are one text run in the page, so selecting it copies the whole value.
 */
export function MiddleText({
  head,
  tail,
  isSecondary = false,
}: {
  head: string;
  tail: string;
  isSecondary?: boolean;
}) {
  const color = isSecondary ? "secondary" : undefined;
  return (
    <Tooltip content={head + tail} hasHoverIndication={false}>
      <HStack gap={0} vAlign="center" wrap="nowrap">
        <StackItem xstyle={styles.give}>
          <Text
            type={isSecondary ? roles.textType.supporting : roles.textType.body}
            color={color}
            maxLines={1}
            hasTruncateTooltip={false}
            hasTabularNumbers
          >
            {head}
          </Text>
        </StackItem>
        <StackItem xstyle={styles.keep}>
          <Text
            type={isSecondary ? roles.textType.supporting : roles.textType.body}
            color={color}
            textWrap="nowrap"
            display="block"
            hasTabularNumbers
          >
            {tail}
          </Text>
        </StackItem>
      </HStack>
    </Tooltip>
  );
}

/** Where an endpoint is cut: before its last path segment ("/v1"), or at its end. */
export function endpointParts(url: string) {
  const cut = url.lastIndexOf("/");
  const at = cut > url.indexOf("//") + 1 ? cut : url.length;
  return { head: url.slice(0, at), tail: url.slice(at) };
}
