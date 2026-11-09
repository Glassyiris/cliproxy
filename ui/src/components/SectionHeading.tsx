// A section heading outside a card: an h2 with an optional icon, hint and controls at the end of
// the row. After card-v2's `SectionHeading` (MIT); card titles use CardHeading, whose
// icon this one's matches.
import type { ReactNode } from "react";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { roles } from "../themes/site/roles.ts";

export function SectionHeading({
  title,
  icon,
  hint,
  actions,
}: {
  title: string;
  icon?: IconProps["icon"];
  /** Supporting text at the end of the row. */
  hint?: string;
  actions?: ReactNode;
}) {
  const heading = <Heading level={roles.heading.section}>{title}</Heading>;
  return (
    <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
      {icon ? (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <Icon icon={icon} size="sm" color="secondary" />
          {heading}
        </HStack>
      ) : (
        heading
      )}
      {(hint || actions) && (
        <HStack vAlign="center" gap={3} wrap="wrap">
          {hint && (
            <Text type={roles.textType.supporting} color="secondary">
              {hint}
            </Text>
          )}
          {actions}
        </HStack>
      )}
    </HStack>
  );
}
