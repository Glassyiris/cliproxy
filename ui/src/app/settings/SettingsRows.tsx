// The settings-dialog template's row idiom: a muted card of divided rows, each row a name and its
// explanation with the control beside it, or under it once the panel is narrow.

import { Children, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, Stack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";

/** The panel column rows measure themselves against. */
const PANEL_CONTAINER = "settings-panel";

// Every row on a panel goes from two columns to one at the same width, measured on the panel
// rather than the viewport (the template's 480px).
const ROW_STACK = "@container settings-panel (max-width: 30rem)";

const ROW_PADDING = 4;

export const row = stylex.create({
  panel: {
    containerType: "inline-size",
    containerName: PANEL_CONTAINER,
  },
  line: {
    display: "flex",
    flexDirection: { default: "row", [ROW_STACK]: "column" },
    alignItems: { default: "center", [ROW_STACK]: "stretch" },
    gap: { default: "var(--spacing-3)", [ROW_STACK]: "var(--spacing-2)" },
  },
  // A flex item shrinks by default, and a shrinking SegmentedControl wraps its longest label.
  control: {
    flexShrink: 0,
  },
});

/** A filled, divided group of rows; the rows carry the inset, so the card has none. */
export function SettingsCard({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <VStack gap={1.5}>
      {title != null && (
        <Text type="supporting" weight="semibold" color="secondary">
          {title}
        </Text>
      )}
      <Card padding={0} width="100%" variant="muted">
        <VStack as="ul" role="list" gap={0}>
          {rows.map((item, index) => (
            <VStack key={index} as="li" gap={0}>
              {index > 0 && <Divider variant="subtle" />}
              {item}
            </VStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}

/**
 * One setting: icon, name and explanation, then the control. `detail` (a picker of tiles) rides
 * inside the row so it lands on the row titles' line. Pass the control `isLabelHidden`: the row is
 * its visible label.
 */
export function SettingsRow({
  title,
  description,
  icon,
  control,
  detail,
}: {
  title: string;
  description?: ReactNode;
  icon: IconProps["icon"];
  control?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <VStack padding={ROW_PADDING} gap={2}>
      <Stack xstyle={row.line}>
        <StackItem size="fill">
          <HStack gap={2} vAlign="start">
            {/* Half a step down: a glyph is centred in its box, a cap height sits low in its line. */}
            <VStack paddingBlockStart={0.5}>
              <Icon icon={icon} size="sm" color="secondary" />
            </VStack>
            <VStack gap={0.5}>
              <Text type="label">{title}</Text>
              {description != null && (
                <Text type="supporting" color="secondary">
                  {description}
                </Text>
              )}
            </VStack>
          </HStack>
        </StackItem>
        {control != null && <VStack xstyle={row.control}>{control}</VStack>}
      </Stack>
      {detail}
    </VStack>
  );
}
