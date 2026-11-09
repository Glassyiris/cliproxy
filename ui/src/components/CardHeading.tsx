// A card's title row: an h3 with an optional icon, controls at the end of the same row and one
// supporting line under it. After card-v2's `CardHeading` (MIT); place it first in
// the card's column.
import type { ReactNode } from "react";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { roles } from "../themes/site/roles.ts";

export function CardHeading({
  title,
  icon,
  description,
  actions,
}: {
  title: string;
  icon?: IconProps["icon"];
  description?: ReactNode;
  actions?: ReactNode;
}) {
  const heading = <Heading level={roles.heading.card}>{title}</Heading>;
  return (
    <VStack gap={1}>
      <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
        {icon ? (
          <HStack gap={2} vAlign="center" wrap="nowrap">
            <Icon icon={icon} size="sm" color="secondary" />
            {heading}
          </HStack>
        ) : (
          heading
        )}
        {actions}
      </HStack>
      {description && (
        <Text type={roles.textType.supporting} color="secondary">
          {description}
        </Text>
      )}
    </VStack>
  );
}
