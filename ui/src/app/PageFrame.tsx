// The one frame every page renders in (DESIGN.md "Roles": page frame and header). The header is
// the dashboard-alert-rail template's, as the Overview draws it: a LayoutHeader with a divider on
// the roles padding, the h1 with its meta line under it, the page's one primary action at the end,
// and a long list's filter row (`toolbar`) under them, which stays in view while the content
// scrolls. The header always spans the full width, so the h1 sits at the same place on every page;
// a reading-width page caps only its content, aligned to the header's start, never centred.
// A detail panel sits at the end behind a resize handle on desktop and is a bottom sheet on phones,
// as the table-filter template docks its job details. A panel with no `onClose` is a permanent rail
// (the dashboard-alert-rail template's): its sections bring their own padding, so the panel adds
// none.

import type { ReactNode } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  VStack,
} from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Heading } from "@astryxdesign/core/Text";
import { t } from "../lib/i18n.ts";
import { layout } from "../themes/site/layout.ts";
import { roles } from "../themes/site/roles.ts";

/**
 * The open detail of a row; the page closes it by no longer passing it. Without `onClose` it is a
 * permanent rail the page always shows beside its content.
 */
export type DetailPanel = { label: string; content: ReactNode; onClose?: () => void };

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
      <LayoutPanel
        resizable={width.props}
        hasDivider
        padding={panel.onClose ? 4 : 0}
        label={panel.label}
      >
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
  toolbar,
  children,
}: {
  title: string;
  meta?: ReactNode;
  /** The page's one primary action. */
  actions?: ReactNode;
  /** DESIGN.md "Roles", content width: a reading page caps its content, a list or dashboard is full. */
  width?: "reading" | "full";
  panel?: DetailPanel;
  /** The filter row of a long list; it stays in view while the list scrolls. */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useAppShellMobile().isMobile;
  return (
    <>
      <Layout
        height="fill"
        end={panel && !isMobile ? <EndPanel panel={panel} /> : undefined}
        header={
          <LayoutHeader hasDivider padding={roles.header.padding}>
            <VStack gap={4}>
              <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
                <VStack gap={0} vAlign="center">
                  <Heading level={roles.heading.page}>{title}</Heading>
                  {meta}
                </VStack>
                {actions}
              </HStack>
              {toolbar}
            </VStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={roles.content.padding}>
            <VStack
              gap={6}
              maxWidth={width === "reading" ? roles.content.settingsWidth : undefined}
            >
              {children}
            </VStack>
          </LayoutContent>
        }
      />
      {isMobile && (
        <BottomSheet
          isOpen={!!panel}
          onOpenChange={(open) => !open && panel?.onClose?.()}
          label={panel?.label ?? ""}
          height="tall"
        >
          {panel?.content}
        </BottomSheet>
      )}
    </>
  );
}
