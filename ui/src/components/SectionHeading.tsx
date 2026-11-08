// A section heading outside a card: an h2 with an optional hint and controls at the end of the
// row. After card-v2 `web/src/ui/SectionHeading.tsx` (MIT); card titles use CardHeading.
import type { ReactNode } from "react";
import { HStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { roles } from "../themes/site/roles.ts";

export function SectionHeading({
  title,
  hint,
  actions,
}: {
  title: string;
  /** Supporting text at the end of the row. */
  hint?: string;
  actions?: ReactNode;
}) {
  return (
    <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
      <Heading level={roles.heading.section}>{title}</Heading>
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
