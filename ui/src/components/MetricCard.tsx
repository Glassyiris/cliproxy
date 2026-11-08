// The key-number card of the nbcards admin (card-v2 `web/src/ui/MetricCard.tsx`, MIT): the label
// row (an icon in the status colour, the label, a chevron when the card links), the value at the
// metric size with an optional badge, and one supporting line. With `href` the whole card is the
// link. The card padding is the one card padding (roles.card).
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Heading } from "@astryxdesign/core/Text";
import { roles } from "../themes/site/roles.ts";
import { Words } from "./Words.tsx";

export function MetricCard({
  label,
  icon,
  iconColor = "secondary",
  iconLabel,
  value,
  badge,
  detail,
  href,
}: {
  label: string;
  icon: IconProps["icon"];
  iconColor?: IconProps["color"];
  /** What the icon's colour says, for a reader who cannot see it. */
  iconLabel?: string;
  /** The value, or its skeleton while loading. */
  value: ReactNode;
  badge?: ReactNode;
  /** One supporting line, or its skeleton. */
  detail?: ReactNode;
  href?: string;
}) {
  const body = (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" wrap="nowrap">
        <Icon icon={icon} size="sm" color={iconColor} label={iconLabel} />
        <StackItem size="fill">
          <Heading level={roles.heading.inCard} accessibilityLevel={roles.heading.card}>
            <Words>{label}</Words>
          </Heading>
        </StackItem>
        {href && <Icon icon={ChevronRight} size="sm" color="secondary" />}
      </HStack>
      <HStack gap={2} vAlign="center" wrap="wrap">
        {value}
        {badge}
      </HStack>
      {detail}
    </VStack>
  );
  return href ? (
    <ClickableCard label={label} href={href} padding={roles.card.padding} height="100%">
      {body}
    </ClickableCard>
  ) : (
    <Card padding={roles.card.padding} height="100%">
      {body}
    </Card>
  );
}
