import { useRef, useState, type Ref } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { ConfigRead } from "./queries.ts";
import { isExcluded } from "./modelConfig.ts";
import { Section } from "./Section.tsx";
import { useRemovalFocus } from "./useRemovalFocus.ts";

function ExcludeForm({
  excluded,
  busy,
  exclude,
  inputRef,
}: {
  excluded: string[];
  busy: boolean;
  inputRef: Ref<HTMLInputElement>;
  /** Writes the new list; true when it was stored. */
  exclude: (pattern: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    const pattern = draft.trim();
    if (!pattern) return setError(t("models.excluded.required"));
    if (isExcluded(excluded, pattern)) return setError(t("models.excluded.duplicate"));
    if (await exclude(pattern)) setDraft("");
  };
  return (
    <HStack gap={2} vAlign="end" wrap="wrap">
      <StackItem size="fill">
        <TextInput
          label={t("models.excluded.field")}
          placeholder={t("models.excluded.placeholder")}
          ref={inputRef}
          value={draft}
          isReadOnly={busy}
          onChange={(value) => {
            setDraft(value);
            setError("");
          }}
          onEnter={() => void submit()}
          status={error ? { type: "error", message: error } : undefined}
        />
      </StackItem>
      <Button
        label={t("models.excluded.submit")}
        variant="secondary"
        isLoading={busy}
        onClick={() => void submit()}
      />
    </HStack>
  );
}

function SkeletonList() {
  return (
    <List density="compact" edge="flush">
      {[0, 1].map((n) => (
        <ListItem
          key={n}
          label={
            <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
          }
        />
      ))}
    </List>
  );
}

export function ExcludedSection({
  channel,
  config,
  excluded,
  busy,
  exclude,
  onAllow,
}: {
  /** The draft belongs to the channel it was typed on. */
  channel: string;
  config: ConfigRead;
  /** Undefined until the config is read. */
  excluded: string[] | undefined;
  busy: boolean;
  exclude: (pattern: string) => Promise<boolean>;
  /** Resolves true when the pattern was allowed. */
  onAllow: (index: number) => Promise<boolean>;
}) {
  const field = useRef<HTMLInputElement>(null);
  const removal = useRemovalFocus(excluded?.length, () => field.current);
  let body;
  if (config.isError)
    body = (
      <ReadError
        error={config.error}
        what={t("models.excluded.what")}
        retry={() => void config.refetch()}
      />
    );
  else if (!excluded) body = <SkeletonList />;
  else if (!excluded.length) body = <EmptyState isCompact title={t("models.excluded.empty")} />;
  else
    body = (
      <List density="compact" edge="flush" hasDividers>
        {excluded.map((pattern, index) => (
          <ListItem
            key={`${index}:${pattern}`}
            label={<Code>{pattern}</Code>}
            endContent={
              <Button
                label={t("models.excluded.allowNamed", { model: pattern })}
                variant="ghost"
                size="sm"
                ref={removal.bind(index)}
                isLoading={busy}
                onClick={() => void removal.run(index, () => onAllow(index))}
              >
                {t("models.excluded.allow")}
              </Button>
            }
          />
        ))}
      </List>
    );
  return (
    <Section heading={t("models.excluded.title")} description={t("models.excluded.description")}>
      <VStack gap={3}>
        {body}
        {excluded && (
          <ExcludeForm
            key={channel}
            excluded={excluded}
            busy={busy}
            exclude={exclude}
            inputRef={field}
          />
        )}
      </VStack>
    </Section>
  );
}
