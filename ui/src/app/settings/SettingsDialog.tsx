// The Astryx page template settings-dialog: a side rail of panels beside the panel, one frame
// height for every panel, and below the narrow breakpoint a title row, a tab strip and the panel.
// Every setting here applies to this browser only, which the Appearance panel says once. About
// reports the server and this build.

import { lazy, Suspense, useId, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Info, Keyboard, Paintbrush, Settings } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Heading, Text } from "@astryxdesign/core/Text";
import { t } from "../../lib/i18n.ts";
import { useDialogParam } from "../pages/PageDialog.tsx";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { PanelHeading } from "./PanelHeading.tsx";
import { row } from "./SettingsRows.tsx";
import { ShortcutsPanel } from "./ShortcutsPanel.tsx";
import { layout } from "../../themes/site/layout.ts";

const styles = stylex.create({
  // SideNav sets a starting width but no flex-shrink, so the pane would squeeze the rail.
  sideNav: {
    flexShrink: 0,
  },
  // Pinned for the whole scroll and taking no height, so it overlays the heading's line.
  closeAnchor: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 1,
    height: 0,
  },
  // Opaque, or the body scrolls visibly through the button.
  closeBacking: {
    display: "flex",
    backgroundColor: "var(--color-background-surface)",
    borderRadius: "var(--radius-element)",
  },
});

type PanelId = "appearance" | "shortcuts" | "about";

const About = lazy(() =>
  import("../../features/system/index.ts").then((m) => ({ default: m.About })),
);

/** The one list both shells read. */
const PANELS: {
  id: PanelId;
  label: () => string;
  icon: IconProps["icon"];
  body: () => ReactNode;
}[] = [
  {
    id: "appearance",
    label: () => t("app.settings.appearance"),
    icon: Paintbrush,
    body: () => <AppearancePanel />,
  },
  {
    id: "shortcuts",
    label: () => t("app.settings.shortcuts"),
    icon: Keyboard,
    body: () => <ShortcutsPanel />,
  },
  {
    id: "about",
    label: () => t("app.settings.about"),
    icon: Info,
    body: () => (
      <Suspense fallback={<Spinner aria-label={t("app.settings.about")} />}>
        <About />
      </Suspense>
    ),
  },
];

const panelOf = (id: PanelId) => PANELS.find((p) => p.id === id) ?? PANELS[0];

type ShellProps = {
  titleId: string;
  active: PanelId;
  onSelect: (panel: PanelId) => void;
  onClose: () => void;
};

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <IconButton
      label={t("app.settings.close")}
      variant="ghost"
      size="sm"
      icon={<Icon icon="close" size="sm" />}
      onClick={onClose}
    />
  );
}

function SettingsSideNav({ titleId, active, onSelect }: Omit<ShellProps, "onClose">) {
  return (
    <SideNav
      aria-label={t("app.settings.sections")}
      xstyle={styles.sideNav}
      // Hand-set rather than SideNavHeading, whose heading is pinned to the large text size; the
      // inset and row height are SideNavHeading's own.
      header={
        <HStack
          gap={2}
          vAlign="center"
          paddingInline={2}
          minHeight={layout.settingsDialog.headingRow}
        >
          <Heading level={4} id={titleId}>
            {t("app.settings.title")}
          </Heading>
        </HStack>
      }
    >
      <SideNavSection title={t("app.settings.sections")} isHeaderHidden>
        {PANELS.map((panel) => (
          <SideNavItem
            key={panel.id}
            label={panel.label()}
            // Pre-rendered: SideNavItem tints an icon it renders itself one step dimmer than its label.
            icon={<Icon icon={panel.icon} size="sm" color="primary" />}
            isSelected={panel.id === active}
            onClick={() => onSelect(panel.id)}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );
}

function ContentPane({ active, onClose }: Pick<ShellProps, "active" | "onClose">) {
  return (
    <LayoutContent isScrollable padding={4}>
      {/* width 100%: without it the sticky box shrinks to the button and lands over the title. */}
      <HStack width="100%" hAlign="end" xstyle={styles.closeAnchor}>
        <HStack xstyle={styles.closeBacking}>
          <CloseButton onClose={onClose} />
        </HStack>
      </HStack>
      <VStack gap={4} xstyle={row.panel}>
        <HStack gap={2} vAlign="start">
          <StackItem size="fill">
            <PanelHeading>{panelOf(active).label()}</PanelHeading>
          </StackItem>
          <VStack aria-hidden="true" width={layout.settingsDialog.closeColumn} />
        </HStack>
        {panelOf(active).body()}
      </VStack>
    </LayoutContent>
  );
}

/** The rail laid on its side at phone width. */
function PanelTabs({ active, onSelect }: Pick<ShellProps, "active" | "onSelect">) {
  return (
    <HStack
      as="nav"
      aria-label={t("app.settings.sections")}
      gap={1}
      wrap="nowrap"
      isScrollable
      paddingInline={3}
      paddingBlock={2}
    >
      {PANELS.map((panel) => (
        <Button
          key={panel.id}
          label={panel.label()}
          icon={<Icon icon={panel.icon} size="sm" />}
          variant={panel.id === active ? "secondary" : "ghost"}
          size="sm"
          aria-current={panel.id === active ? "page" : undefined}
          onClick={() => onSelect(panel.id)}
        />
      ))}
    </HStack>
  );
}

function NarrowShell({ titleId, active, onSelect, onClose }: ShellProps) {
  return (
    <VStack gap={0} height="100%">
      <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={3}>
        <StackItem size="fill">
          {/* A title row, not a navigation head: the panel's own heading is the only one here. */}
          <Text type="label" id={titleId}>
            {t("app.settings.title")}
          </Text>
        </StackItem>
        <CloseButton onClose={onClose} />
      </HStack>
      <Divider />
      <PanelTabs active={active} onSelect={onSelect} />
      <Divider />
      <StackItem size="fill">
        <VStack gap={4} padding={4} isScrollable height="100%" xstyle={row.panel}>
          <PanelHeading>{panelOf(active).label()}</PanelHeading>
          {panelOf(active).body()}
        </VStack>
      </StackItem>
    </VStack>
  );
}

function SettingsDialog({
  isOpen,
  onOpenChange,
  initial,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  initial: PanelId;
}) {
  const [active, setActive] = useState<PanelId>(initial);
  const titleId = useId();
  const isNarrow = useMediaQuery(layout.settingsDialog.narrowViewport);
  const close = () => onOpenChange(false);
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width={layout.settingsDialog.width}
      maxHeight={layout.settingsDialog.height}
      padding={0}
      aria-labelledby={titleId}
    >
      {/* One height for every panel: the panel scrolls, the frame does not grow. */}
      <VStack height={layout.settingsDialog.height}>
        {isNarrow ? (
          <NarrowShell titleId={titleId} active={active} onSelect={setActive} onClose={close} />
        ) : (
          <Layout
            start={<SettingsSideNav titleId={titleId} active={active} onSelect={setActive} />}
            content={<ContentPane active={active} onClose={close} />}
          />
        )}
      </VStack>
    </Dialog>
  );
}

/**
 * The side nav's settings button and the dialog it opens; closing returns focus to it. `?open=about`
 * opens it on About.
 */
export function SettingsButton() {
  const [isOpen, setOpen] = useState(false);
  const about = useDialogParam("about");
  const label = t("app.settings.title");
  return (
    <>
      <IconButton
        label={label}
        tooltip={label}
        variant="ghost"
        icon={<Icon icon={Settings} size="sm" />}
        onClick={() => setOpen(true)}
      />
      <SettingsDialog
        // Remounted per opening reason, so each starts on its own panel.
        key={about.isOpen ? "about" : "button"}
        isOpen={isOpen || about.isOpen}
        initial={about.isOpen ? "about" : "appearance"}
        onOpenChange={(open) => {
          setOpen(open);
          if (!open && about.isOpen) about.close();
        }}
      />
    </>
  );
}
