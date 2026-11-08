// The app frame, as the owner's BoothDex console has it (admin/admin-shell.tsx) from the Astryx page
// template shell-side-nav: AppShell with one collapsible, resizable SideNav: its heading on top, the
// page sections from routes.ts, the session rows in the footer, and the colour-mode toggle and the
// settings button in the footer icon row beside the collapse button. On phones AppShell turns the nav into its drawer
// behind its own bar. There is no top bar.

import { LogOut, Plug, Server } from "lucide-react";
import { Suspense, useEffect, useMemo, useState, type AnchorHTMLAttributes } from "react";
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
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { lampVariant, StatusLamp } from "../components/StatusLamp.tsx";
import { t } from "../lib/i18n.ts";
import { repository } from "../lib/repository.ts";
import { layout } from "../themes/site/layout.ts";
import { useConnectAccount } from "./connect-entry.ts";
import { PageWarning } from "./Notices.tsx";
import { FooterPreferences } from "./PreferenceMenus.tsx";
import { usePreferences } from "./preferences.ts";
import { QueryBoundary } from "./QueryBoundary.tsx";
import { navGroups, routes, type NavGroup, type PageRoute } from "./routes.ts";
import { shortcuts } from "./settings/ShortcutsPanel.tsx";
import { useSession } from "./Session.tsx";
import { useDocumentTitle } from "./useDocumentTitle.ts";
import { leaveOrAsk, useBlockedNavigation, useHashRoute } from "./useHashRoute.ts";

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
        icon={Plug}
        endContent={<StatusDot variant={lampVariant[status]} label={state} />}
      />
    </Popover>
  );
}

/** "Go to page": a footer row (SideNav has no search slot) and Ctrl/Cmd+K, listing every page. */
function GoToPage() {
  const [isOpen, setOpen] = useState(false);
  const { locale } = usePreferences();
  // The titles come from the catalog, so the list is rebuilt when the language changes.
  const source = useMemo(() => {
    const group = (r: PageRoute) => navGroups.find((g) => g.id === r.group)?.title() ?? "";
    return createStaticSource(
      routes.map((r) => ({ id: r.id, label: r.title(), auxiliaryData: { group: group(r) } })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale changes what t() returns
  }, [locale]);
  const connectAccount = useConnectAccount();
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
        onValueChange={(id) => {
          setOpen(false);
          if (id === "connect") connectAccount();
          else location.hash = `#${id}`;
        }}
      />
    </>
  );
}

/**
 * The nav categories that are open. The current page's opens whenever the page changes, so a page
 * reached by link or from the palette is never hidden; the others keep what the operator chose.
 * Adjusted while rendering when the page changes, as React's docs do for state derived from a prop.
 */
function useOpenGroups(current: NavGroup) {
  const [open, setOpen] = useState<ReadonlySet<NavGroup>>(() => new Set([current]));
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    if (!open.has(current)) setOpen(new Set([...open, current]));
  }
  const toggle = (id: NavGroup, isOpen: boolean) =>
    setOpen((was) => {
      const next = new Set(was);
      if (isOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  return [open, toggle] as const;
}

function PageNav({ current }: { current: PageRoute }) {
  const { signOut } = useSession();
  const [open, toggle] = useOpenGroups(current.group);
  return (
    <SideNav
      collapsible
      resizable={layout.sidebar}
      header={
        <SideNavHeading
          heading={t("app.brand.name")}
          // The mark itself, as BoothDex's heading: NavIcon would paint an accent disc behind it.
          icon={<Icon icon={Server} />}
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
      <SideNavSection title={t("app.nav.pages")} isHeaderHidden>
        {navGroups.map((group) => {
          const pages = routes.filter((r) => r.group === group.id && !r.selects);
          if (!pages.length) return null;
          const items = pages.map((r) => (
            <SideNavItem
              key={r.id}
              label={r.title()}
              icon={r.icon}
              href={`#${r.id}`}
              isSelected={r === current || r.id === current.selects}
            />
          ));
          if (group.id === navGroups[0].id) return items;
          return (
            <SideNavItem
              key={group.id}
              label={group.title()}
              icon={group.icon}
              collapsible={{
                isCollapsed: !open.has(group.id),
                onCollapsedChange: (isCollapsed) => toggle(group.id, !isCollapsed),
              }}
            >
              {items}
            </SideNavItem>
          );
        })}
      </SideNavSection>
    </SideNav>
  );
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
      <DiscardChanges />
    </AppShell>
  );
}
