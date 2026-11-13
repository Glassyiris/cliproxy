// The one frame every page renders in (DESIGN.md "Pages"), after the card-v2 admin's PageFrame
// (card-v2's `PageFrame`, MIT): Astryx Layout with the padding set once on it, so the
// header and the content share one line and the h1 sits at the same place on every page; the
// header holds the h1, one supporting line, the page's controls at the end (under the line when
// they do not fit beside the title), a long list's filter row and the route's tabs, which sit on
// the header's divider; the body is a column of sections spaced by the section gap, ending with
// the bottom padding, and stops at the content width.
// A detail panel sits at the end behind a resize handle on desktop and is a bottom sheet on phones,
// as the table-filter template docks its job details. A panel with no `onClose` is a permanent
// rail: its sections bring their own padding, so the panel adds none.
//
// A page hosted by a route (app/pages/) renders through the host: as a tab, its frame takes the
// route's title, tabs and controls; inside a dialog, the dialog's frame draws the title, pins the
// filter row under it and the footer at its foot, and scrolls the controls and body between.

import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import * as stylex from "@stylexjs/stylex";
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

const styles = stylex.create({
  // The controls keep the gap they had beside the title; the line sits right under the title.
  titleRows: {
    columnGap: "var(--spacing-3)",
    rowGap: 0,
  },
  fullRow: {
    flexBasis: "100%",
  },
  // Under the line, at the end, a card gap (`roles.gap.card`) below it. A flex container, so the
  // controls keep their own width for the measurement rather than taking the row's.
  controlsBelow: {
    order: 1,
    flexBasis: "100%",
    display: "flex",
    justifyContent: "flex-end",
    marginBlockStart: "var(--spacing-4)",
  },
});

// Only a phone shows the detail panel as a sheet, so the desktop never loads it.
const BottomSheet = lazy(() =>
  import("@astryxdesign/core/BottomSheet").then((m) => ({ default: m.BottomSheet })),
);

/**
 * The open detail of a row; omitting it closes the panel. Without `onClose` it is a
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

type TitleRefs = {
  row: RefObject<HTMLElement | null>;
  heading: RefObject<HTMLHeadingElement | null>;
  controls: RefObject<HTMLElement | null>;
};

/**
 * Whether the page's controls fit beside the h1's text in the title row. Only the title and the
 * controls are measured, never the line under the title, so data arriving cannot move them.
 */
function useControlsBeside(
  { row, heading, controls }: TitleRefs,
  hasControls: boolean,
  titleText: string,
) {
  const [beside, setBeside] = useState(true);
  useLayoutEffect(() => {
    const measure = () => {
      if (!row.current || !heading.current || !controls.current) return;
      const text = document.createRange();
      text.selectNodeContents(heading.current);
      const title = text.getBoundingClientRect();
      // A title squeezed onto two lines beside the controls is itself the sign they do not fit.
      // Its first line's box is the one-line height (a computed line-height may be "normal").
      const firstLine = text.getClientRects()[0];
      const oneLine = !firstLine || title.height < firstLine.height * 1.5;
      const gap = parseFloat(getComputedStyle(row.current).columnGap) || 0;
      const need = title.width + gap + controls.current.getBoundingClientRect().width;
      setBeside(oneLine && need <= row.current.clientWidth);
    };
    measure();
    void document.fonts?.ready.then(measure);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const el of [row.current, heading.current, controls.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [row, heading, controls, hasControls, titleText]);
  return beside;
}

/** The line under the title, held while a page's meta waits for its data, so nothing moves. */
function SupportingLine({ meta }: { meta: ReactNode }) {
  return (
    meta || (
      <Text type={roles.textType.supporting} aria-hidden>
        {"\u00a0"}
      </Text>
    )
  );
}

/**
 * The h1 with the controls at the end of its row, and its line under that row. Controls that do
 * not fit beside the title (a phone with two labelled buttons) take their own row under the line
 * as one group, rather than splitting the title from its line. One wrapping row holds all three
 * and only the controls' placement changes, so they stay mounted (an open menu or confirmation
 * survives the switch).
 */
function TitleRows({
  heading,
  title,
  titleText,
  meta,
  controls,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  /** The h1, holding `heading`. */
  title: ReactNode;
  titleText: string;
  meta: ReactNode;
  controls: ReactNode;
}) {
  const row = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLElement>(null);
  const beside = useControlsBeside({ row, heading, controls: controlsRef }, !!controls, titleText);
  return (
    <HStack ref={row} vAlign="start" wrap="wrap" xstyle={styles.titleRows}>
      <StackItem size="fill">{title}</StackItem>
      {controls && (
        <StackItem size="static" xstyle={beside ? undefined : styles.controlsBelow}>
          {/* Measured at its full width beside the title; on its own row it may wrap. */}
          <HStack
            ref={controlsRef}
            gap={3}
            vAlign="center"
            hAlign="end"
            wrap={beside ? "nowrap" : "wrap"}
          >
            {controls}
          </HStack>
        </StackItem>
      )}
      <VStack xstyle={styles.fullRow}>
        <SupportingLine meta={meta} />
      </VStack>
    </HStack>
  );
}

/** The title rows, then the filter row and the route's tabs. */
function FrameHeader({
  title,
  meta,
  actions,
  toolbar,
  host,
}: Pick<FrameProps, "title" | "meta" | "actions" | "toolbar"> & { host: PageHost | null }) {
  const tab = host?.kind === "tab" ? host : null;
  const heading = useRef<HTMLHeadingElement>(null);
  const controls = (tab?.actions || actions) && (
    <>
      {tab?.actions}
      {actions}
    </>
  );
  return (
    <LayoutHeader paddingBlockEnd={tab?.tabs ? 0 : undefined}>
      <VStack gap={roles.gap.card}>
        <TitleRows
          heading={heading}
          title={
            <Heading ref={heading} level={roles.heading.page}>
              {tab?.title ?? title}
            </Heading>
          }
          titleText={tab?.title ?? title}
          meta={meta}
          controls={controls}
        />
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
