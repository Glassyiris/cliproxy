import type { ReactNode } from "react";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";

/** One region of the page: a heading, an optional supporting line, then its content. */
export function Section({
  heading,
  description,
  children,
}: {
  heading: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={2}>{heading}</Heading>
        {description && (
          <Text type="supporting" color="secondary">
            {description}
          </Text>
        )}
      </VStack>
      {children}
    </VStack>
  );
}
