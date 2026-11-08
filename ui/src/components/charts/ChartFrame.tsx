import { useId, type MouseEvent, type ReactNode } from "react";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Icon } from "@astryxdesign/core/Icon";
import { Square } from "lucide-react";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { focusOutlineStyles } from "@astryxdesign/core/utils/focusOutline.stylex";
import { swatch } from "../../themes/site/charts.ts";

export type Series = keyof typeof swatch;

/** A series' swatch, drawn as the dashboard templates draw it, beside its name. */
export function LegendDot({ series, label }: { series: Series; label: string }) {
  return (
    <HStack gap={2} vAlign="center" wrap="nowrap">
      <Icon icon={Square} size="xsm" xstyle={swatch[series]} />
      <Text type="supporting" color="secondary" textWrap="nowrap">
        {label}
      </Text>
    </HStack>
  );
}

/**
 * recharts 3 makes the SVG a tab stop (arrow keys move its tooltip) and focuses an inner layer on
 * click, where the browser draws its own square outline. A pointer press inside the frame does not
 * move focus, so that outline never appears; keyboard focus still reaches the chart, and the frame
 * draws the Astryx focus ring around it.
 */
function keepFocus(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
}

/**
 * The layout every chart shares, loaded or not: the legend, the plot under the accessible name
 * `label`, and the one-sentence `summary` under it, which is also the plot's description.
 */
export function ChartFrame({
  label,
  summary,
  legend,
  plot,
  children,
}: {
  label: string;
  summary: string;
  legend?: readonly { series: Series; label: string }[];
  plot: StyleXStyles;
  children: ReactNode;
}) {
  const summaryId = useId();
  return (
    <VStack gap={3}>
      {legend ? (
        <HStack gap={4} wrap="wrap" vAlign="center">
          {legend.map((item) => (
            <LegendDot key={item.series} series={item.series} label={item.label} />
          ))}
        </HStack>
      ) : null}
      <VStack
        role="group"
        aria-label={label}
        aria-describedby={summaryId}
        xstyle={[focusOutlineStyles.focusWithin, plot]}
        onMouseDownCapture={keepFocus}
      >
        {children}
      </VStack>
      <Text type="supporting" color="secondary" id={summaryId}>
        {summary}
      </Text>
    </VStack>
  );
}
