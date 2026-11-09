// The app frame, as the BoothDex console has it from the Astryx page
// template shell-side-nav: AppShell with one collapsible, resizable SideNav: its heading on top, the
// six pages from routes.ts as flat items, the session rows in the footer, and the colour-mode toggle and the
// settings button in the footer icon row beside the collapse button. On phones AppShell turns the nav into its drawer
// behind its own bar. There is no top bar.

import { LogOut, Network } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, type AnchorHTMLAttributes } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Center } from "@astryxdesign/core/Center";
import { CommandPalette } from "@astryxdesign/core/CommandPalette";
import { useHotkeys } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { Kbd } from "@astryxdesign/core/Kbd";
import { VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Popover } from "@astryxdesign/core/Popover";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
  useSideNavCollapse,
} from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { icons } from "../components/icons.ts";
import { lampVariant, StatusLamp } from "../components/StatusLamp.tsx";
import { t } from "../lib/i18n.ts";
import { repository } from "../lib/repository.ts";
import { layout } from "../themes/site/layout.ts";
import { PageDialog, useDialogParam } from "./pages/PageDialog.tsx";
import { PageWarning } from "./Notices.tsx";
import { ColorModeToggle } from "./PreferenceMenus.tsx";
import { usePreferences } from "./preferences.ts";
import { QueryBoundary } from "./QueryBoundary.tsx";
import { destinations, navSections, routes, type NavRef, type PageRoute } from "./routes.ts";
import { SettingsButton } from "./settings/SettingsDialog.tsx";
import { shortcuts } from "./settings/ShortcutsPanel.tsx";
import { useSession } from "./Session.tsx";
import { useDocumentTitle } from "./useDocumentTitle.ts";
import { leaveOrAsk, useBlockedNavigation, useHashParams, useHashRoute } from "./useHashRoute.ts";

/** SideNavItem's link, opening in a new tab: the item has no `target` of its own. */
function NewTabLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} target="_blank" rel="noreferrer" />;
}

/**
 * Keyboard and screen-reader focus moves to the page title after sign-in and after every page
 * change: the shell only mounts once a key is accepted, and the sign-in field it replaces is gone.
 */
function FocusHeading() {
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>("[role=main] h1");
    if (!heading) return;
    heading.tabIndex = -1;
    // A heading is a reading position, not a control: no focus ring around the title.
    heading.focus({ focusVisible: false });
  }, []);
  return null;
}

/** The host and its lamp, as a nav row (the template's StatusDot end content); the popover adds the build. */
function ConnectionItem() {
  const { online, version, commit } = useSession();
  const host = location.host;
  const state = online ? t("app.connection.connected", { host }) : t("app.connection.lost");
  const status = online ? "ready" : "failing";
  const notReported = t("app.connection.notReported");
  return (
    <Popover
      label={t("app.connection.label")}
      placement="end"
      alignment="end"
      content={
        <VStack gap={3}>
          <StatusLamp status={status} label={state} />
          <MetadataList>
            <MetadataListItem label={t("app.connection.version")}>
              {version ? <Text type="code">{version}</Text> : notReported}
            </MetadataListItem>
            <MetadataListItem label={t("app.connection.commit")}>
              {commit && commit !== "none" ? <Text type="code">{commit}</Text> : notReported}
            </MetadataListItem>
          </MetadataList>
        </VStack>
      }
    >
      <SideNavItem
        label={host}
        icon={icons.use}
        endContent={<StatusDot variant={lampVariant[status]} label={state} />}
      />
    </Popover>
  );
}

/**
 * The side nav's footer icon row, beside its collapse button: the colour-mode toggle and the
 * settings button. `footerIcons` is the slot SideNav also stacks in the collapsed rail.
 */
function FooterPreferences() {
  return (
    <>
      <ColorModeToggle iconSize="sm" />
      <SettingsButton />
    </>
  );
}

/** "Go to page": a footer row (SideNav has no search slot) and Ctrl/Cmd+K, listing every place. */
function GoToPage() {
  const [isOpen, setOpen] = useState(false);
  const { locale } = usePreferences();
  // The titles come from the catalog, so the list is rebuilt when the language changes.
  const source = useMemo(() => {
    const page = (id: string) => routes.find((r) => r.id === id)?.title() ?? "";
    return createStaticSource(
      destinations.map((d) => ({
        id: d.hash,
        label: d.title(),
        auxiliaryData: { group: page(d.route) },
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale changes what t() returns
  }, [locale]);
  useHotkeys([{ keys: shortcuts.goToPage, onPress: () => setOpen(true), allowInInputs: true }]);
  return (
    <>
      <SideNavItem
        label={t("app.palette.label")}
        icon="search"
        endContent={<Kbd keys={shortcuts.goToPage} />}
        onClick={() => setOpen(true)}
      />
      <CommandPalette
        isOpen={isOpen}
        onOpenChange={setOpen}
        searchSource={source}
        label={t("app.palette.label")}
        emptySearchText={t("app.palette.empty")}
        onValueChange={(hash) => {
          setOpen(false);
          location.hash = hash;
        }}
      />
    </>
  );
}

type NavEntry = { key: string; label: string; icon: PageRoute["icon"]; href: string; on: boolean };

/** The view a route shows for `?view=`: the named one when it has it, else its first. */
const shownViewOf = (r: PageRoute, view?: string) =>
  (r.views?.find((x) => x.id === view) ?? r.views?.[0])?.id;

/** A side-nav item's name, icon, link and whether it is the page shown. */
function navEntry({ route, view }: NavRef, current: PageRoute, shownView?: string): NavEntry {
  const r = routes.find((x) => x.id === route);
  if (!r) throw new Error(`side nav names an unknown route: ${route}`);
  const v = r.views?.find((x) => x.id === view);
  if (!v)
    return {
      key: r.id,
      label: r.navTitle?.() ?? r.title(),
      icon: r.icon,
      href: `#${r.id}`,
      on: r === current,
    };
  return {
    key: `${r.id}-${v.id}`,
    label: v.title(),
    icon: v.icon,
    href: v.id === r.views?.[0]?.id ? `#${r.id}` : `#${r.id}?view=${v.id}`,
    on: r === current && v.id === shownViewOf(r, shownView),
  };
}

/**
 * The pages in `navSections`, each section's name a small heading over its items, never collapsed.
 * In the collapsed rail every page is its own icon, so reaching one is one
 * click.
 */
function PageSections({ current }: { current: PageRoute }) {
  const { isCollapsed } = useSideNavCollapse();
  const [params] = useHashParams();
  return navSections.map((section) => (
    <SideNavSection key={section.id} title={section.title()} isHeaderHidden={isCollapsed}>
      {section.items
        .map((ref) => navEntry(ref, current, params.view))
        .map((e) => (
          <SideNavItem key={e.key} label={e.label} icon={e.icon} href={e.href} isSelected={e.on} />
        ))}
    </SideNavSection>
  ));
}

function PageNav({ current }: { current: PageRoute }) {
  const { signOut } = useSession();
  return (
    <SideNav
      collapsible
      // Astryx keeps the width and the collapsed rail in localStorage under this key (read and
      // written in try/catch), so someone who prefers the rail keeps it across reloads. Collapsed,
      // each page is one icon with its name as SideNavItem's own tooltip (PageSections).
      resizable={{ ...layout.sidebar, autoSaveId: "cliproxy-side-nav" }}
      header={
        <SideNavHeading
          heading={t("app.brand.name")}
          // The mark itself, as BoothDex's heading: NavIcon would paint an accent disc behind it.
          icon={<Icon icon={Network} />}
          headingHref={`#${routes[0].id}`}
        />
      }
      footerIcons={<FooterPreferences />}
      footer={
        <SideNavSection title={t("app.nav.footer")} isHeaderHidden>
          <ConnectionItem />
          <GoToPage />
          <SideNavItem
            label={t("app.nav.github")}
            icon="externalLink"
            href={repository.url}
            as={NewTabLink}
          />
          {/* Asked like a page change; a sign-out the server forces (Session.tsx) is not. */}
          <SideNavItem
            label={t("app.nav.signOut")}
            icon={LogOut}
            onClick={() => leaveOrAsk(signOut)}
          />
        </SideNavSection>
      }
    >
      <PageSections current={current} />
    </SideNav>
  );
}

const Connect = lazy(() => import("../features/connect/index.ts"));

/** Connecting an account opens over whichever page asked for it (`?open=connect`). */
function ConnectDialog() {
  const connect = useDialogParam("connect");
  return (
    <PageDialog isOpen={connect.isOpen} title={t("app.nav.connect")} onClose={connect.close}>
      <Connect />
    </PageDialog>
  );
}

/**
 * Every page's chunk is fetched once the browser is idle after sign-in, so the first visit to a
 * page does not wait for its chunks (a first visit to Accounts fetched 13 of them).
 */
function usePrefetchPages() {
  useEffect(() => {
    const prefetch = () => {
      for (const r of routes) void r.preload();
      void import("../features/connect/index.ts");
    };
    if (!("requestIdleCallback" in window)) {
      const timer = setTimeout(prefetch, 1000);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(prefetch);
    return () => cancelIdleCallback(idle);
  }, []);
}

/** Asked when a page change or sign-out would drop unsaved edits (the guard in useHashRoute.ts). */
function DiscardChanges() {
  const { isBlocked, stay, discard } = useBlockedNavigation();
  return (
    <AlertDialog
      isOpen={isBlocked}
      onOpenChange={(open) => !open && stay()}
      title={t("app.unsaved.title")}
      description={t("app.unsaved.description")}
      actionLabel={t("app.unsaved.discard")}
      cancelLabel={t("app.unsaved.keep")}
      onAction={discard}
    />
  );
}

export function Shell() {
  const { route } = useHashRoute();
  useDocumentTitle(t("app.document.pageTitle", { title: route.title() }));
  usePrefetchPages();
  const Page = route.page;

  return (
    <AppShell contentPadding={0} sideNav={<PageNav current={route} />}>
      <QueryBoundary resetKey={route.id}>
        <Suspense
          key={route.id}
          fallback={
            <Center axis="both" padding={10}>
              <Spinner aria-label={t("app.read.loading", { what: route.title() })} />
            </Center>
          }
        >
          <PageWarning />
          <Page />
          <FocusHeading />
        </Suspense>
      </QueryBoundary>
      <ConnectDialog />
      <DiscardChanges />
    </AppShell>
  );
}
