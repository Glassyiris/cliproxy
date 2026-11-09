import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/Layout";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { typeScaleVars } from "@astryxdesign/core/theme/tokens.stylex";
import type { CredState, Lamp } from "../lib/credentials.ts";
import { t } from "../lib/i18n.ts";
import { span } from "../lib/time.ts";
import type { Status } from "../themes/site/index.ts";

/** The status of each credential lamp from `credState` (src/lib/credentials.ts). */
export const lampStatus = {
  ok: "ready",
  warn: "cooling",
  bad: "failing",
  off: "disabled",
} as const satisfies Record<Lamp, Status>;

/** The word beside a credential's lamp, in the current language. */
export function stateWord(s: CredState, now: number): string {
  const until = s.until ?? now;
  switch (s.state) {
    case "disabled":
      return t("app.credState.disabled");
    case "limited":
      return s.nextCheck
        ? t("app.credState.limited", { until, next: span(s.nextCheck - now) })
        : t("app.credState.limitedOnRequest", { until });
    case "cooling":
      return t("app.credState.cooling", { time: span(until - now) });
    case "signIn":
      return t("app.credState.signIn");
    case "unavailable":
      return t("app.credState.unavailable");
    case "error":
      return t("app.credState.error");
    case "ready":
      return t("app.credState.ready");
    case "other":
      return s.status ?? "";
  }
}

/** The StatusDot variant each status takes; the theme maps their tokens to the Rosé Pine hues. */
export const lampVariant = {
  ready: "success",
  cooling: "warning",
  failing: "error",
  disabled: "neutral",
} as const satisfies Record<Status, StatusDotVariant>;

const styles = stylex.create({
  // The supporting word's line is shorter than a body line, so beside body text in the same row
  // its first line sat 2.5 px high; centred in a body-height line it lines up.
  // The leading token is a multiplier, so the height is size x leading.
  bodyLine: {
    minHeight: `calc(${typeScaleVars["--text-body-size"]} * ${typeScaleVars["--text-body-leading"]})`,
  },
});

/**
 * A status lamp with its word beside it, so the state never rests on colour alone. The word is
 * secondary text, as in the BoothDex console: Astryx's Text has
 * no status colours, and the theme adds none. `isPulsing` marks a live thing (log tail, sign-in
 * waiting, live usage). `isLabelHidden` drops the word where the control around the lamp already
 * says it (a toggle button's label); the lamp keeps it as its accessible label. `isBodyLine` sets
 * the lamp's line to a body line's height, for a cell whose neighbours' first line is body text.
 */
export function StatusLamp({
  status,
  label,
  isPulsing = false,
  isLabelHidden = false,
  isBodyLine = false,
}: {
  status: Status;
  label: string;
  isPulsing?: boolean;
  isLabelHidden?: boolean;
  isBodyLine?: boolean;
}) {
  const lamp = <StatusDot variant={lampVariant[status]} label={label} isPulsing={isPulsing} />;
  if (isLabelHidden) return lamp;
  return (
    <HStack gap={1.5} vAlign="center" xstyle={isBodyLine ? styles.bodyLine : undefined}>
      {lamp}
      <Text type="supporting" color="secondary">
        {label}
      </Text>
    </HStack>
  );
}
