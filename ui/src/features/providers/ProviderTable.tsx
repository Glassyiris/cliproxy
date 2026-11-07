import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Code } from "@astryxdesign/core/Code";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, useTableGroupedRows, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { TrafficStrip } from "../../components/TrafficStrip.tsx";
import { mask } from "../../lib/client-keys.ts";
import { sum, type Buckets } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { modelText, type Family, type Group, type Key } from "./groups.ts";

type Row = {
  id: string;
  group: number;
  /** Null for the placeholder row of a group that holds no keys. */
  key: Key | null;
  buckets: Buckets | null;
};

export type GroupAction = { kind: "toggle" | "delete"; index: number };

const skeletonRows: Row[] = ["a", "b", "c"].map((id) => ({
  id,
  group: 0,
  key: null,
  buckets: null,
}));

function GroupHeader({
  group,
  name,
  compat,
  saving,
  onAction,
}: {
  group: Group;
  name: string;
  compat: boolean;
  saving: boolean;
  onAction: (kind: GroupAction["kind"]) => void;
}) {
  const models = group.models?.filter((m) => m.name) ?? [];
  return (
    // The header cell lays its content out in a flex row that only wraps what it holds, so the
    // fill item takes the row's width; the pinned chevron sits one gutter inside the table's edge
    // (the table bleeds into the page padding), so the content starts one gutter further in.
    <StackItem size="fill">
      <HStack gap={3} vAlign="center" paddingInlineStart={4}>
        <StackItem size="fill">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text weight="bold">{name}</Text>
              <Badge variant="neutral" label={group.keys?.length ?? 0} />
              {group.disabled && (
                <StatusLamp status="disabled" label={t("app.credState.disabled")} />
              )}
            </HStack>
            {group["base-url"] ? (
              <Code>{group["base-url"]}</Code>
            ) : (
              <Text type="supporting" color="secondary">
                {t("providers.group.defaultEndpoint")}
              </Text>
            )}
            {models.length > 0 && (
              <HStack gap={1} wrap="wrap">
                {models.map((m, i) => (
                  <Code key={i}>{modelText(m)}</Code>
                ))}
              </HStack>
            )}
          </VStack>
        </StackItem>
        {/* The header row toggles its group on any click; the menu must not. */}
        <HStack onClick={(e) => e.stopPropagation()}>
          <MoreMenu
            label={t("providers.group.menu", { name })}
            size="sm"
            icon={
              saving ? <Spinner size="sm" aria-label={t("providers.group.saving")} /> : undefined
            }
            items={[
              ...(compat
                ? [
                    {
                      label: group.disabled
                        ? t("providers.group.enable")
                        : t("providers.group.disable"),
                      onClick: () => onAction("toggle"),
                    },
                  ]
                : []),
              {
                label: t("providers.group.delete"),
                variant: "destructive" as const,
                onClick: () => onAction("delete"),
              },
            ]}
          />
        </HStack>
      </HStack>
    </StackItem>
  );
}

function columnsFor(
  groups: Group[] | undefined,
  revealed: boolean,
  trafficPending: boolean,
  max: number,
): TableColumn<Row>[] {
  const loading = !groups;
  const bar = (): ReactNode => (
    <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
  );
  return [
    {
      key: "key",
      header: t("providers.table.key"),
      renderCell: (row) => {
        if (loading) return bar();
        if (!row.key) return <Text color="secondary">{t("providers.table.noKeys")}</Text>;
        const value = String(row.key["api-key"] ?? "");
        return (
          <Text type="code" textWrap={revealed ? "wrap" : "nowrap"}>
            {revealed ? value : mask(value)}
          </Text>
        );
      },
    },
    {
      key: "weight",
      header: t("providers.table.weight"),
      align: "end",
      renderCell: (row) =>
        loading ? bar() : row.key && <Text hasTabularNumbers>{row.key.weight ?? 1}</Text>,
    },
    {
      key: "traffic",
      header: t("providers.table.traffic"),
      renderCell: (row) => {
        if (loading || (row.key && trafficPending)) return bar();
        return row.buckets && <TrafficStrip buckets={row.buckets} max={max} />;
      },
    },
    {
      key: "requests",
      header: t("providers.table.requests"),
      align: "end",
      renderCell: (row) =>
        !loading &&
        row.buckets && (
          <Text hasTabularNumbers>
            {t("providers.table.count", { count: sum(row.buckets.total) })}
          </Text>
        ),
    },
  ];
}

/** Placeholder rows in the table's shape while the config loads. */
export function ProviderTableSkeleton() {
  return (
    <Table<Row> data={skeletonRows} columns={columnsFor(undefined, false, false, 1)} idKey="id" />
  );
}

/**
 * One section per group (the collapse state is kept by the group's index), its keys beneath. `traffic`
 * is undefined while the usage report is still loading or when the server has none.
 */
export function ProviderTable({
  family,
  groups,
  names,
  revealed,
  traffic,
  trafficPending,
  max,
  saving,
  onAction,
}: {
  family: Family;
  groups: Group[];
  /**
   * Display names of `groups`, in order. A section is keyed "<index>: <name>" (Astryx reads the key
   * out in the toggle's accessible name); only the index addresses a group, so a name never does.
   */
  names: string[];
  revealed: boolean;
  traffic: (group: Group, key: Key) => Buckets | null;
  trafficPending: boolean;
  max: number;
  /** The group whose toggle is being written, if any. */
  saving: number | null;
  onAction: (action: GroupAction) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(
    () =>
      groups.flatMap((group, index): Row[] =>
        group.keys?.length
          ? group.keys.map((key, k) => ({
              id: `${index}:${k}`,
              group: index,
              key,
              buckets: traffic(group, key),
            }))
          : [{ id: `${index}:none`, group: index, key: null, buckets: null }],
      ),
    [groups, traffic],
  );
  const grouped = useTableGroupedRows<Row>({
    data: rows,
    groupBy: (row) => `${row.group}: ${names[row.group]}`,
    collapsedGroups: collapsed,
    onToggleGroup: (section) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(section)) next.add(section);
        return next;
      }),
    getRowKey: (row) => row.id,
    renderGroupHeader: (section) => {
      const index = Number.parseInt(section, 10);
      return (
        <GroupHeader
          group={groups[index]}
          name={names[index]}
          compat={family === "openai-compatibility"}
          saving={saving === index}
          onAction={(kind) => onAction({ kind, index })}
        />
      );
    },
  });
  return (
    <Table<Row>
      data={grouped.data}
      columns={columnsFor(groups, revealed, trafficPending, max)}
      idKey={grouped.idKey}
      density="compact"
      plugins={{ grouped: grouped.plugin }}
    />
  );
}
