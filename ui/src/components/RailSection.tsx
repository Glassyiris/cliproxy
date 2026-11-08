import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";

const railStyles = stylex.create({
  // Translucent, so the band reads the same on a card and on the panel.
  header: {
    backgroundColor: "var(--color-background-muted)",
  },
  // The opaque layer the translucent band needs; without it the rows read
  // through the header as they scroll past.
  stickyHeader: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 1,
    backgroundColor: "var(--color-background-surface)",
  },
});

/**
 * One labelled region of the triage rail. `hasStickyHeader` is the rail form: the header band
 * spans the panel and pins to its top while the list scrolls, and the rows keep the page's inset
 * from the window edge. Folded inline, the section sits in its own card.
 */
export function RailSection({
  icon,
  iconColor = "secondary",
  title,
  subtitle,
  badge,
  hasStickyHeader = false,
  children,
}: {
  icon: IconProps["icon"];
  iconColor?: "error" | "secondary";
  title: string;
  /** One supporting line under the title; empty draws none. */
  subtitle: string;
  /** A count at the header's end. */
  badge?: ReactNode;
  hasStickyHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <VStack gap={0}>
      <VStack gap={0} xstyle={hasStickyHeader ? railStyles.stickyHeader : undefined}>
        <VStack gap={1} padding={4} xstyle={railStyles.header}>
          <HStack gap={2} vAlign="center">
            <Icon icon={icon} size="sm" color={iconColor} />
            <StackItem size="fill">
              <Heading level={3} accessibilityLevel={2}>
                {title}
              </Heading>
            </StackItem>
            {badge}
          </HStack>
          {subtitle && (
            <Text type="supporting" color="secondary">
              {subtitle}
            </Text>
          )}
        </VStack>
        <Divider />
      </VStack>
      {hasStickyHeader ? <VStack paddingInline={4}>{children}</VStack> : children}
    </VStack>
  );
}
