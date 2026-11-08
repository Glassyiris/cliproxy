import { HStack, VStack } from "@astryxdesign/core/Layout";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import type { Bar, QuotaWhy } from "../lib/credentials.ts";
import { money, t } from "../lib/i18n.ts";
import type { QuotaError } from "../lib/quota.ts";
import type { Window, WindowLabel } from "../lib/quotaWindows.ts";
import { span } from "../lib/time.ts";
import { Words } from "./Words.tsx";

/** A window's title in the current language; plugin and Kimi titles are the server's own text. */
export function windowLabel(label: WindowLabel): string {
  if ("text" in label) return label.text;
  switch (label.name) {
    case "session":
      return t("app.quota.session");
    case "weekAll":
      return t("app.quota.weekAll");
    case "weekModel":
      return t("app.quota.weekModel", { model: label.model });
    case "otherLimit":
      return t("app.quota.otherLimit");
    case "extraUsage":
      return t("app.quota.extraUsage");
    case "fiveHourLimit":
      return t("app.quota.fiveHourLimit");
    case "weeklyLimit":
      return t("app.quota.weeklyLimit");
    case "lengthLimit":
      return t("app.quota.lengthLimit", { length: span(label.seconds * 1000) });
    case "primaryLimit":
      return t("app.quota.primaryLimit");
    case "secondaryLimit":
      return t("app.quota.secondaryLimit");
    case "daily":
      return t("app.quota.daily");
    case "weekly":
      return t("app.quota.weekly");
  }
}

/** Why a quota check failed, in the current language; other failures keep their own text. */
export function quotaErrorText(error: QuotaError): string {
  switch (error.reason) {
    case "usageDenied":
      return t("app.quota.usageDenied", { status: error.status });
    case "tokenRefused":
      return t("app.quota.tokenRefused", { status: error.status });
    case "status":
      return t("app.quota.providerStatus", { status: error.status });
    case "timeout":
      return t("app.connection.timeout");
    case "unreachable":
      return t("app.connection.unreachable");
    case "malformed":
      return t("app.quota.malformed");
    case "failed":
      return error.detail;
  }
}

const whyText: Record<QuotaWhy, () => string> = {
  notChecked: () => t("app.quota.notChecked"),
  notReported: () => t("app.quota.notReported"),
  readFailed: () => t("app.quota.readFailed"),
  noWindows: () => t("app.quota.noWindows"),
  noSource: () => t("app.quota.noSource"),
};

/** The line under the bar: how old kept numbers are, the extra-usage spend, or when it resets. */
function note(window: Window, staleFor: number | null, now: number) {
  if (staleFor !== null) return t("app.quota.old", { age: span(staleFor) });
  const { extra } = window;
  if (extra) {
    const spent = money(extra.spent.amount, extra.spent.currency);
    return extra.limit
      ? t("app.quota.spentOf", { spent, limit: money(extra.limit.amount, extra.limit.currency) })
      : t("app.quota.spentNoLimit", { spent });
  }
  const reset = Date.parse(window.reset);
  return reset > now ? t("app.quota.resetsIn", { time: span(reset - now) }) : "";
}

/**
 * One quota window as Astryx's ProgressBar with its label, percent used and reset time, or the
 * reason there is no number. Numbers kept past a refused sign-in are greyed and dated. The
 * compact variant, for table cells, hides the label the column header already gives.
 */
export function QuotaWindow({
  bar,
  now,
  isCompact = false,
}: {
  bar: Bar;
  /** The time the reset is counted from: the list's render time, as accountRow's. */
  now: number;
  isCompact?: boolean;
}) {
  if ("why" in bar)
    return (
      <Text type="supporting" color="secondary">
        {whyText[bar.why]()}
      </Text>
    );
  const { window, staleFor } = bar;
  const label = windowLabel(window.label);
  const line = note(window, staleFor, now);
  if (window.used === null)
    return (
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="body">{label}</Text>
        <Text type="supporting" color="secondary">
          <Words>{line}</Words>
        </Text>
      </HStack>
    );
  return (
    <VStack gap={1}>
      <ProgressBar
        label={label}
        isLabelHidden={isCompact}
        value={window.used}
        hasValueLabel
        variant={window.used >= 90 ? "error" : "neutral"}
        isDisabled={staleFor !== null}
      />
      {line && (
        <Text type="supporting" color="secondary">
          <Words>{line}</Words>
        </Text>
      )}
    </VStack>
  );
}
