import type { ReactNode } from "react";
import { VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { roles } from "../themes/site/roles.ts";

/** A list cell of two lines (Accounts, Provider keys): the value, and a secondary line under it. */
export function TwoLines({ first, second }: { first: ReactNode; second: ReactNode }) {
  return (
    <VStack gap={0.5}>
      {first}
      {typeof second === "string" ? (
        <Text type={roles.textType.supporting} color="secondary" maxLines={1} hasTabularNumbers>
          {second}
        </Text>
      ) : (
        second
      )}
    </VStack>
  );
}
