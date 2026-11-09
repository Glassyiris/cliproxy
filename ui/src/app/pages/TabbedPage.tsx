// A route whose pages sit under one side-nav category (DESIGN.md "Routes"): each is `?view=<id>` on
// the route, the first has none, and the side nav switches between them; no tab strip in the page.
// The hosted page's frame takes the view's title as its h1 and the route's controls.

import type { ComponentType, ReactNode } from "react";
import { PageHostContext } from "../pageHost.ts";
import { useHashParams } from "../useHashRoute.ts";

type HostedTab = { id: string; label: () => string; page: ComponentType };

export function TabbedPage({
  tabs,
  actions,
}: {
  tabs: readonly [HostedTab, ...HostedTab[]];
  actions?: ReactNode;
}) {
  const [params] = useHashParams();
  const active = tabs.find((tab) => tab.id === params.view) ?? tabs[0];
  const Page = active.page;
  return (
    <PageHostContext value={{ kind: "tab", title: active.label(), tabs: null, actions }}>
      <Page key={active.id} />
    </PageHostContext>
  );
}
