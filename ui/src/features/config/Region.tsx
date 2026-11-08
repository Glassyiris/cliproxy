import type { ReactNode } from "react";
import { Grid } from "@astryxdesign/core/Grid";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { layout } from "../../themes/site/layout.ts";

/** One settings section of the `settings` template: heading and supporting text, then controls. */
export function Region({
  heading,
  description,
  children,
}: {
  heading: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Grid columns={{ minWidth: layout.settingsColumnMin }} gap={10}>
      <VStack gap={1}>
        <Heading level={3} accessibilityLevel={2}>
          {heading}
        </Heading>
        <Text type="supporting" color="secondary">
          {description}
        </Text>
      </VStack>
      <VStack gap={4}>{children}</VStack>
    </Grid>
  );
}
