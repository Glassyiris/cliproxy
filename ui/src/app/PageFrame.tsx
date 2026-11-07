// The frame of every page, as the owner's BoothDex console has it (admin/page-frame.tsx) from the
// header of the Astryx page template detail-page: a LayoutHeader with a divider and the template's
// padding, the h1 with its meta line beside it, the page's primary action at the header's end, and
// the content on the same padding, so it starts on the header's left edge. On a phone the meta
// takes its own line under the title and the action drops below both (detail-page, mobile).
// A detail panel sits at the end behind a resize handle on desktop and is a bottom sheet on phones,
// as the table-filter template docks its job details, so the list beside it does not reflow.

import type { ReactNode } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  StackItem,
  VStack,
} from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Heading } from "@astryxdesign/core/Text";
import { t } from "../lib/i18n.ts";
import { layout } from "../themes/site/layout.ts";

/** The open detail of a row; the page closes it by no longer passing it. */
export type DetailPanel = { label: string; content: ReactNode; onClose: () => void };

function EndPanel({ panel }: { panel: DetailPanel }) {
  const width = useResizable(layout.detailPanel);
  return (
    <>
      <ResizeHandle
        resizable={width.props}
        isReversed
        isAlwaysVisible={false}
        label={t("app.panel.resize", { panel: panel.label })}
      />
      <LayoutPanel resizable={width.props} hasDivider padding={4} label={panel.label}>
        {panel.content}
      </LayoutPanel>
    </>
  );
}

export function PageFrame({
  title,
  meta,
  actions,
  width = "reading",
  panel,
  children,
}: {
  title: string;
  meta?: ReactNode;
  /** The page's one primary action. */
  actions?: ReactNode;
  /** DESIGN.md "Content width": 960 for forms, settings and System; full for list + panel screens. */
  width?: "reading" | "full";
  panel?: DetailPanel;
  children: ReactNode;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const heading = <Heading level={1}>{title}</Heading>;
  return (
    <>
      <Layout
        height="fill"
        contentWidth={width === "reading" ? layout.pageWidth : undefined}
        end={panel && !isMobile ? <EndPanel panel={panel} /> : undefined}
        header={
          <LayoutHeader hasDivider padding={4}>
            {isMobile ? (
              <VStack gap={3}>
                <VStack gap={1}>
                  {heading}
                  {meta}
                </VStack>
                {actions}
              </VStack>
            ) : (
              <HStack gap={4} vAlign="center">
                <StackItem size="fill">
                  <HStack gap={3} vAlign="center" wrap="wrap">
                    {heading}
                    {meta}
                  </HStack>
                </StackItem>
                {actions}
              </HStack>
            )}
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={4}>
            <VStack gap={6}>{children}</VStack>
          </LayoutContent>
        }
      />
      {isMobile && (
        <BottomSheet
          isOpen={!!panel}
          onOpenChange={(open) => !open && panel?.onClose()}
          label={panel?.label ?? ""}
          height="tall"
        >
          {panel?.content}
        </BottomSheet>
      )}
    </>
  );
}
