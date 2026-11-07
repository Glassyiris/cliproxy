import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import type { UseQueryResult } from "@tanstack/react-query";
import { ReadError } from "../../components/ReadError.tsx";
import { ApiError } from "../../lib/api/client.ts";
import type { Config } from "../../lib/api/config.ts";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import type { Buckets } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { type Family, type Group, type Key } from "./groups.ts";
import { ProviderTable, ProviderTableSkeleton, type GroupAction } from "./ProviderTable.tsx";
import { familyName } from "./ProviderToolbar.tsx";

/** The usage report failing leaves the keys listed without strips; the server lacking it is a fact, not a fault. */
function UsageNotice({ query }: { query: UseQueryResult<ApiKeyUsage> }) {
  if (query.error instanceof ApiError && query.error.notImplemented)
    return <Banner status="info" title={t("providers.usage.unavailable")} />;
  return (
    <ReadError
      error={query.error}
      what={t("providers.usage.what")}
      retry={() => void query.refetch()}
    />
  );
}

/** Everything under the toolbar: the read's failures, then its skeleton, empty state or table. */
export function ProviderBody({
  family,
  config,
  usage,
  groups,
  names,
  revealed,
  traffic,
  max,
  saving,
  addButton,
  onAction,
}: {
  family: Family;
  config: UseQueryResult<Config>;
  usage: UseQueryResult<ApiKeyUsage>;
  /** Undefined until the config is read. */
  groups: Group[] | undefined;
  names: string[];
  revealed: boolean;
  traffic: (group: Group, key: Key) => Buckets | null;
  max: number;
  saving: number | null;
  addButton: ReactNode;
  onAction: (action: GroupAction) => void;
}) {
  return (
    <>
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("providers.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {usage.isError && <UsageNotice query={usage} />}
      {config.isPending && <ProviderTableSkeleton />}
      {groups?.length === 0 && (
        <EmptyState
          title={t("providers.empty.title", { family: familyName(family) })}
          description={t("providers.empty.description")}
          headingLevel={2}
          actions={addButton}
        />
      )}
      {!!groups?.length && (
        <ProviderTable
          family={family}
          groups={groups}
          names={names}
          revealed={revealed}
          traffic={traffic}
          trafficPending={usage.isPending}
          max={max}
          saving={saving}
          onAction={onAction}
        />
      )}
    </>
  );
}
