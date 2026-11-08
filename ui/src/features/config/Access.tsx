import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import type { Config } from "../../lib/api/config.ts";
import { readPath } from "../../lib/configPath.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { Row } from "./SettingRow.tsx";

/** A link to the page where a set of keys is managed, in body colour with a chevron. */
function Manage({ href, what }: { href: string; what: string }) {
  return (
    <HStack>
      <Link href={href}>
        <HStack gap={1} vAlign="center">
          {t("config.access.manage", { what: what.toLowerCase() })}
          <Icon icon="chevronRight" size="sm" />
        </HStack>
      </Link>
    </HStack>
  );
}

/** The keys this server holds are managed on their own pages; this group links there. */
export function Access({ config }: { config: Config | undefined }) {
  const clients: unknown = config && readPath(config, "access/api-keys", []);
  return (
    <VStack gap={0}>
      <Row label={t("config.access.clients")}>
        <VStack gap={1}>
          {config ? (
            <Text type="body" hasTabularNumbers>
              {t("config.access.count", { count: Array.isArray(clients) ? clients.length : 0 })}
            </Text>
          ) : (
            <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
          )}
          <Manage href="#clients" what={t("config.access.clients")} />
        </VStack>
      </Row>
      <Divider />
      <Row label={t("config.access.providers")}>
        <Manage href="#accounts?view=providers" what={t("config.access.providers")} />
      </Row>
      <Divider />
    </VStack>
  );
}
