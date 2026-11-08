// The one frame every page renders in (DESIGN.md "Pages"), after the nbcards admin's PageFrame
// (card-v2 `web/src/ui/PageFrame.tsx`, MIT): Astryx Layout with the padding set once on it, so the
// header and the content share one line and the h1 sits at the same place on every page; the
// header holds the h1, one supporting line, the page's controls at the end, a long list's filter
// row and the route's tabs, which sit on the header's divider; the body is a column of sections
// spaced by the section gap, ending with the bottom padding, and stops at the content width.
// A detail panel sits at the end behind a resize handle on desktop and is a bottom sheet on phones,
// as the table-filter template docks its job details. A panel with no `onClose` is a permanent
// rail: its sections bring their own padding, so the panel adds none.
//
// A page hosted by a route (app/pages/) renders through the host: as a tab, its frame takes the
// route's title, tabs and controls; inside a dialog, the dialog's frame draws the title, pins the
// filter row under it and the footer at its foot, and scrolls the controls and body between.

import { lazy, Suspense, useContext, useEffect, useRef, type ReactNode } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { useMediaQuery } from "@astryxdesign/core/hooks";
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
import { Heading, Text } from "@astryxdesign/core/Text";
import { t } from "../lib/i18n.ts";
import { layout } from "../themes/site/layout.ts";
import { roles } from "../themes/site/roles.ts";
import { PageHostContext, type PageHost } from "./pageHost.ts";

// Only a phone shows the detail panel as a sheet, so the desktop never loads it.
const BottomSheet = lazy(() =>
  import("@astryxdesign/core/BottomSheet").then((m) => ({ default: m.BottomSheet })),
);

/**
 * The open detail of a row; the page closes it by no longer passing it. Without `onClose` it is a
 * permanent rail the page always shows beside its content.
 */
type DetailPanel = { label: string; content: ReactNode; onClose?: () => void };

/** A field Esc belongs to: closing the panel from it would drop what was typed. */
const isEditable = (el: Element) =>
  el.matches("input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]");

/**
 * Esc from inside a closable panel closes it, as the phone's sheet does, unless focus is in a
 * field; focus then goes back to what had it before it entered the panel (the row that opened it),
 * when the page has not already put it somewhere.
 */
function useEscapeCloses(onClose: (() => void) | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  // Pages pass a fresh closure each render; the listeners read the latest and stay subscribed, so
  // the opener they track survives re-renders.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const closable = !!onClose;
  useEffect(() => {
    if (!closable) return;
    let outside: HTMLElement | null = null;
    const onFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (!ref.current?.contains(target)) outside = target;
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "Escape" || event.defaultPrevented || !ref.current?.contains(target))
        return;
      if (isEditable(target)) return;
      close.current?.();
      const opener = outside;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if ((!active || active === document.body) && opener?.isConnected) opener.focus();
      });
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, [closable]);
  return ref;
}

function EndPanel({ panel }: { panel: DetailPanel }) {
  const width = useResizable(layout.detailPanel);
  const ref = useEscapeCloses(panel.onClose);
  return (
    <>
      <ResizeHandle
        resizable={width.props}
        isReversed
        isAlwaysVisible={false}
        label={t("app.panel.resize", { panel: panel.label })}
      />
      <LayoutPanel
        ref={ref}
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

type FrameProps = {
  title: string;
  /** The one supporting line under the h1. */
  meta?: ReactNode;
  /** The page's controls, at most one of them primary. */
  actions?: ReactNode;
  /** DESIGN.md "Roles", content width: a reading page caps its content, a list or dashboard is full. */
  width?: "reading" | "full";
  panel?: DetailPanel;
  /** A long list's filter row or a wizard's stepper; it stays in view while the body scrolls. */
  toolbar?: ReactNode;
  /** The buttons that close the body (a wizard's Back and next); pinned at a dialog's foot. */
  footer?: ReactNode;
  children: ReactNode;
};

/** A hosted page inside a dialog: the dialog has the title, so only the controls and the body. */
function DialogBody({ meta, actions, children }: FrameProps) {
  return (
    <VStack gap={roles.gap.section}>
      {(meta || actions) && (
        <HStack gap={3} vAlign="center" wrap="wrap">
          <StackItem size="fill">{meta}</StackItem>
          {actions}
        </HStack>
      )}
      {children}
    </VStack>
  );
}

/** The h1 with its line, the controls at the end, then the filter row and the route's tabs. */
function FrameHeader({
  title,
  meta,
  actions,
  toolbar,
  host,
}: Pick<FrameProps, "title" | "meta" | "actions" | "toolbar"> & { host: PageHost | null }) {
  const tab = host?.kind === "tab" ? host : null;
  return (
    <LayoutHeader paddingBlockEnd={tab?.tabs ? 0 : undefined}>
      <VStack gap={roles.gap.card}>
        <HStack gap={3} vAlign="start" wrap="wrap">
          <StackItem size="fill">
            <VStack gap={0}>
              <Heading level={roles.heading.page}>{tab?.title ?? title}</Heading>
              {/* The line is held while a page's meta waits for its data, so nothing moves. */}
              {meta || (
                <Text type={roles.textType.supporting} aria-hidden>
                  {"\u00a0"}
                </Text>
              )}
            </VStack>
          </StackItem>
          {tab?.actions}
          {actions}
        </HStack>
        {toolbar}
        {tab?.tabs}
      </VStack>
    </LayoutHeader>
  );
}

export function PageFrame(props: FrameProps) {
  const { width = "reading", panel, footer, children } = props;
  const host = useContext(PageHostContext);
  const isMobile = useAppShellMobile().isMobile;
  const isPhone = useMediaQuery(layout.phone);
  if (host?.kind === "dialog")
    return host.frame({ header: props.toolbar, content: <DialogBody {...props} />, footer });
  return (
    <>
      <Layout
        height="fill"
        padding={isPhone ? roles.page.phonePadding : roles.page.padding}
        defaultHasDividers
        end={panel && !isMobile ? <EndPanel panel={panel} /> : undefined}
        header={<FrameHeader {...props} host={host} />}
        content={
          <LayoutContent>
            <VStack
              gap={roles.gap.section}
              paddingBlockEnd={roles.page.bottomPadding}
              maxWidth={width === "reading" ? roles.content.settingsWidth : undefined}
            >
              {children}
              {footer}
            </VStack>
          </LayoutContent>
        }
      />
      {isMobile && (
        <Suspense fallback={null}>
          <BottomSheet
            isOpen={!!panel}
            onOpenChange={(open) => !open && panel?.onClose?.()}
            label={panel?.label ?? ""}
            height={roles.detailSheet.height}
          >
            {panel?.content}
          </BottomSheet>
        </Suspense>
      )}
    </>
  );
}
