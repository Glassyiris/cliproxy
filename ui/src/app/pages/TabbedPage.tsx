// A route whose header carries tabs, each an earlier page hosted unchanged (DESIGN.md "Routes"):
// the tab is `?view=<id>` on the route, the first tab has none. The hosted page's frame takes the
// route's title, these tabs and the route's controls (PageFrame `PageHostContext`).

import type { ComponentType, ReactNode } from "react";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { PageHostContext } from "../pageHost.ts";
import { useHashParams } from "../useHashRoute.ts";

export type HostedTab = { id: string; label: () => string; page: ComponentType };

export function TabbedPage({
  route,
  title,
  tabs,
  actions,
}: {
  route: string;
  title: string;
  tabs: readonly [HostedTab, ...HostedTab[]];
  actions?: ReactNode;
}) {
  const [params] = useHashParams();
  const active = tabs.find((tab) => tab.id === params.view) ?? tabs[0];
  // A tab is a new place: its own filters and open item do not follow it.
  const hashOf = (id: string) => (id === tabs[0].id ? `#${route}` : `#${route}?view=${id}`);
  const strip = (
    <TabList
      value={active.id}
      onChange={(id) => {
        location.hash = hashOf(id);
      }}
      isFullBleed
    >
      {tabs.map((tab) => (
        <Tab key={tab.id} value={tab.id} label={tab.label()} href={hashOf(tab.id)} />
      ))}
    </TabList>
  );
  const Page = active.page;
  return (
    <PageHostContext value={{ kind: "tab", title, tabs: strip, actions }}>
      <Page key={active.id} />
    </PageHostContext>
  );
}
