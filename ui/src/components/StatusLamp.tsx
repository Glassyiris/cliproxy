import { HStack } from "@astryxdesign/core/Layout";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import type { Status } from "../themes/site/index.ts";

/** The StatusDot variant each status takes; the theme maps their tokens to the Rosé Pine hues. */
export const lampVariant = {
  ready: "success",
  cooling: "warning",
  failing: "error",
  disabled: "neutral",
} as const satisfies Record<Status, StatusDotVariant>;

/**
 * A status lamp with its word beside it, so the state never rests on colour alone. The word is
 * secondary text, as in the owner's BoothDex console (admin/live-status.tsx): Astryx's Text has
 * no status colours, and the theme adds none.
 */
export function StatusLamp({ status, label }: { status: Status; label: string }) {
  return (
    <HStack gap={1.5} vAlign="center">
      <StatusDot variant={lampVariant[status]} label={label} />
      <Text type="supporting" color="secondary">
        {label}
      </Text>
    </HStack>
  );
}
