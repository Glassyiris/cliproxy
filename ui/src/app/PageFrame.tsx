// The frame of every page, as the owner's BoothDex console has it (admin/page-frame.tsx) from the
// header of the Astryx page template detail-page: a LayoutHeader with a divider and the template's
// padding, the h1 with its meta line beside it, the page's primary action at the header's end, and
// the content on the same padding, so it starts on the header's left edge. On a phone the meta
// takes its own line under the title and the action drops below both (detail-page, mobile).

import type { ReactNode } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  StackItem,
  VStack,
} from "@astryxdesign/core/Layout";
import { Heading } from "@astryxdesign/core/Text";
import { layout } from "../themes/site/layout.ts";

export function PageFrame({
  title,
  meta,
  actions,
  children,
}: {
  title: string;
  meta?: ReactNode;
  /** The page's one primary action. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const heading = <Heading level={1}>{title}</Heading>;
  return (
    <Layout
      height="fill"
      contentWidth={layout.pageWidth}
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
  );
}
