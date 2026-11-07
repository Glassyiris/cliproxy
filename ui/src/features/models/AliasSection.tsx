import type { RefObject } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Token } from "@astryxdesign/core/Token";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import type { Alias } from "./modelConfig.ts";
import type { ConfigRead } from "./queries.ts";
import { Section } from "./Section.tsx";
import { SkeletonTable } from "./SkeletonTable.tsx";
import { useRemovalFocus } from "./useRemovalFocus.ts";

interface Row extends Record<string, unknown> {
  id: string;
  alias: Alias;
}

export function AliasSection({
  config,
  aliases,
  busy,
  onRemove,
  addButton,
}: {
  config: ConfigRead;
  /** Undefined until the config is read. */
  aliases: Alias[] | undefined;
  busy: boolean;
  /** Resolves true when the alias was removed. */
  onRemove: (index: number) => Promise<boolean>;
  /** Where focus goes when the last alias is removed. */
  addButton: RefObject<HTMLButtonElement | null>;
}) {
  const removal = useRemovalFocus(aliases?.length, () => addButton.current);
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: t("models.alias.upstream"),
      renderCell: ({ alias }) => <Code>{alias.name}</Code>,
    },
    {
      key: "alias",
      header: t("models.alias.alias"),
      renderCell: ({ alias }) => (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Code>{alias.alias}</Code>
          {alias.fork && <Token label={t("models.alias.keepsOriginal")} size="sm" />}
        </HStack>
      ),
    },
    {
      key: "actions",
      header: t("models.alias.actions"),
      align: "end",
      renderCell: ({ id, alias }) => (
        <Button
          label={t("models.alias.removeNamed", { alias: alias.alias })}
          variant="ghost"
          size="sm"
          ref={removal.bind(Number(id))}
          isLoading={busy}
          onClick={() => void removal.run(Number(id), () => onRemove(Number(id)))}
        >
          {t("models.alias.remove")}
        </Button>
      ),
    },
  ];

  let body;
  if (config.isError)
    body = (
      <ReadError
        error={config.error}
        what={t("models.alias.what")}
        retry={() => void config.refetch()}
      />
    );
  else if (!aliases)
    body = <SkeletonTable density="compact" headers={columns.map((c) => c.header as string)} />;
  else if (!aliases.length) body = <EmptyState isCompact title={t("models.alias.empty")} />;
  else
    body = (
      <Table<Row>
        data={aliases.map((alias, index) => ({ id: String(index), alias }))}
        columns={columns}
        idKey="id"
        density="compact"
        hasHover
      />
    );
  return (
    <Section heading={t("models.alias.title")} description={t("models.alias.description")}>
      {body}
    </Section>
  );
}
