import { HStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import type { Status } from "../themes/site/index.ts";

/** A status lamp with its word beside it, so the state never rests on colour alone. */
export function StatusLamp({ status, label }: { status: Status; label: string }) {
  return (
    <HStack gap={1.5} vAlign="center">
      <StatusDot variant={status} label={label} />
      <Text type="supporting" color={status === "disabled" ? "secondary" : status}>
        {label}
      </Text>
    </HStack>
  );
}
