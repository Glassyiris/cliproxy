import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import type { Config } from "../../lib/api/config.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { isKnown, sectionNames, summarize, type KnownSection } from "./sections.ts";

const meaning: Record<KnownSection | "other", () => string> = {
  server: () => t("config.section.server"),
  management: () => t("config.section.management"),
  access: () => t("config.section.access"),
  routing: () => t("config.section.routing"),
  requests: () => t("config.section.requests"),
  "api-keys": () => t("config.section.apiKeys"),
  oauth: () => t("config.section.oauth"),
  client: () => t("config.section.client"),
  multimedia: () => t("config.section.multimedia"),
  observability: () => t("config.section.observability"),
  plugins: () => t("config.section.plugins"),
  other: () => t("config.section.other"),
};

const skeleton = () => (
  <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
);

export function SectionListSkeleton() {
  return (
    <List aria-busy hasDividers edge="outset">
      {sectionNames({}).map((name) => (
        <ListItem key={name} label={skeleton()} description={skeleton()} />
      ))}
    </List>
  );
}

function summaryText(value: unknown) {
  const summary = summarize(value);
  if (summary.kind === "default") return t("config.sections.default");
  if (summary.kind === "count") return t("config.sections.count", { count: summary.count });
  return summary.text;
}

export function SectionList({
  config,
  onOpen,
}: {
  config: Config;
  onOpen: (name: string) => void;
}) {
  return (
    <List hasDividers edge="outset">
      {sectionNames(config).map((name) => (
        <ListItem
          key={name}
          label={<Text type="code">{name}</Text>}
          description={meaning[isKnown(name) ? name : "other"]()}
          endContent={
            <HStack gap={2} vAlign="center">
              <Text type="supporting" color="secondary">
                {summaryText(config[name])}
              </Text>
              <Icon icon="chevronRight" size="sm" color="secondary" />
            </HStack>
          }
          onClick={() => onOpen(name)}
        />
      ))}
    </List>
  );
}
