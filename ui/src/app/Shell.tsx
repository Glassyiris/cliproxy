import { Suspense, useEffect } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Icon } from "@astryxdesign/core/Icon";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { BrandIcon, SignOutIcon } from "../components/icons.tsx";
import { StatusLamp } from "../components/StatusLamp.tsx";
import { t } from "../lib/i18n.ts";
import { layout } from "../themes/site/layout.ts";
import { PageWarning } from "./Notices.tsx";
import { PreferenceMenus } from "./PreferenceMenus.tsx";
import { QueryBoundary } from "./QueryBoundary.tsx";
import { routes } from "./routes.ts";
import { useSession } from "./Session.tsx";
import { useDocumentTitle } from "./useDocumentTitle.ts";
import { useHashRoute } from "./useHashRoute.ts";

// Opened in a new tab: leaving this one would drop the key held in memory.
const REPOSITORY = "https://github.com/vayungodara/cliproxy-rs";

/** After a page change, keyboard and screen-reader focus moves to the new page's title. */
function FocusHeading({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const heading = document.querySelector<HTMLElement>("[role=main] h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [enabled]);
  return null;
}

function ConnectionState() {
  const { online, version } = useSession();
  if (!online) return <StatusLamp status="failing" label={t("app.connection.lost")} />;
  return (
    <VStack gap={0.5}>
      <StatusLamp status="ready" label={t("app.connection.connected", { host: location.host })} />
      {version ? (
        <Text type="supporting" color="secondary">
          {t("app.connection.version", { version })}
        </Text>
      ) : null}
    </VStack>
  );
}

export function Shell() {
  const { route, navigated } = useHashRoute();
  const { signOut } = useSession();
  useDocumentTitle(t("app.document.pageTitle", { title: route.title() }));
  const Page = route.page;

  return (
    <AppShell
      contentPadding={0}
      sideNav={
        <SideNav
          collapsible
          resizable={layout.sidebar}
          header={
            <SideNavHeading
              heading={t("app.brand.name")}
              headingHref={`#${routes[0].id}`}
              icon={<NavIcon icon={<Icon icon={BrandIcon} size="sm" />} />}
            />
          }
          footer={
            <SideNavSection title={t("app.nav.session")} isHeaderHidden>
              <VStack paddingInline={2} paddingBlock={2}>
                <ConnectionState />
              </VStack>
              <SideNavItem
                label={t("app.nav.github")}
                icon="externalLink"
                onClick={() => void open(REPOSITORY, "_blank", "noopener,noreferrer")}
              />
              <SideNavItem label={t("app.nav.signOut")} icon={SignOutIcon} onClick={signOut} />
            </SideNavSection>
          }
          footerIcons={<PreferenceMenus />}
        >
          <SideNavSection title={t("app.nav.label")} isHeaderHidden>
            {routes.map((r) => (
              <SideNavItem
                key={r.id}
                label={r.title()}
                icon={r.icon}
                href={`#${r.id}`}
                isSelected={r === route}
              />
            ))}
          </SideNavSection>
        </SideNav>
      }
    >
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
          <FocusHeading enabled={navigated} />
        </Suspense>
      </QueryBoundary>
    </AppShell>
  );
}
