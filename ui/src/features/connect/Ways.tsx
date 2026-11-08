import { useId } from "react";
import { Field } from "@astryxdesign/core/Field";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon, type IconType } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { Text } from "@astryxdesign/core/Text";
import { icons } from "../../components/icons.ts";
import { usePlugins } from "../../app/serverQueries.ts";
import { useAvailable } from "../../components/MissingActions.tsx";
import { providerIcon } from "../../components/ProviderIcon.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { routes } from "../../lib/api/routes.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { builtIn, owner } from "./flow.ts";

/** How an account is connected: a provider's sign-in, a Vertex service account, or an API key. */
export type Way = { kind: "signIn"; provider: string } | { kind: "vertex" } | { kind: "apiKey" };

const wayKey = (way: Way) => (way.kind === "signIn" ? `signIn:${way.provider}` : way.kind);

type Choice = { way: Way; name: string; icon: IconType; line: string; reason: string | null };

/**
 * One labelled group of choice cards, one line each for the name and the description, the reason
 * a choice is disabled taking the description's place, so a choice turning unavailable moves
 * nothing.
 */
function Choices({
  title,
  choices,
  chosen,
  onChoose,
}: {
  title: string;
  choices: Choice[];
  chosen: string;
  onChoose: (way: Way) => void;
}) {
  const inputID = useId();
  const labelID = useId();
  return (
    <Field label={title} inputID={inputID} labelID={labelID} isGroupLabel>
      <Grid
        id={inputID}
        role="radiogroup"
        aria-labelledby={labelID}
        columns={{ minWidth: layout.summaryTileMin }}
        gap={2}
      >
        {choices.map((c) => (
          <SelectableCard
            key={wayKey(c.way)}
            label={c.name}
            isSelected={chosen === wayKey(c.way)}
            isDisabled={c.reason !== null}
            onChange={() => onChoose(c.way)}
            padding={3}
          >
            <VStack gap={1}>
              <HStack gap={1.5} vAlign="center" wrap="nowrap">
                <Icon icon={c.icon} size="sm" />
                <StackItem size="fill">
                  <Text type="label" maxLines={1}>
                    {c.name}
                  </Text>
                </StackItem>
              </HStack>
              <Text type="supporting" color="secondary" maxLines={1}>
                {/* A blank line keeps its height, so a reason arriving later moves nothing. */}
                {c.reason ?? (c.line || "\u00a0")}
              </Text>
            </VStack>
          </SelectableCard>
        ))}
      </Grid>
    </Field>
  );
}

/** Step 1: every way to connect, the ones this server cannot do drawn disabled with the reason. */
export function Ways({
  chosen,
  onChoose,
  gone,
}: {
  chosen: Way | null;
  onChoose: (way: Way) => void;
  /** The ways this server answered as not available. */
  gone: string[];
}) {
  const plugins = usePlugins();
  const available = useAvailable();
  const canStart = available(routes.startOAuth);
  const fromPlugins = (plugins.data?.plugins ?? [])
    .filter((p) => p.supports_oauth)
    .map((p) => p.oauth_provider || p.id);
  const unavailable = t("connect.providers.unavailable");
  const providers = [...new Set([...builtIn, ...fromPlugins])].map((provider): Choice => ({
    way: { kind: "signIn", provider },
    name: label(provider),
    icon: providerIcon(provider),
    // Only where the page is not the provider's own (Codex signs in on OpenAI's).
    line:
      owner(provider) === label(provider)
        ? ""
        : t("connect.way.approveOn", { owner: owner(provider) }),
    reason: !canStart ? t("connect.way.noSignIn") : gone.includes(provider) ? unavailable : null,
  }));
  const other: Choice[] = [
    {
      way: { kind: "vertex" },
      name: t("connect.way.vertex"),
      icon: providerIcon("vertex"),
      line: t("connect.way.vertexLine"),
      reason: available(routes.importOAuth) && !gone.includes("vertex") ? null : unavailable,
    },
    {
      way: { kind: "apiKey" },
      name: t("connect.way.apiKey"),
      icon: icons.providerKeys,
      line: "",
      reason: null,
    },
  ];
  const key = chosen ? wayKey(chosen) : "";
  return (
    <FormLayout>
      <VStack gap={2} aria-busy={plugins.isPending}>
        <Choices
          title={t("connect.way.providers")}
          choices={providers}
          chosen={key}
          onChoose={onChoose}
        />
        {plugins.isError && (
          <ReadError
            error={plugins.error}
            what={t("connect.providers.what")}
            retry={() => void plugins.refetch()}
          />
        )}
      </VStack>
      <Choices title={t("connect.way.other")} choices={other} chosen={key} onChoose={onChoose} />
    </FormLayout>
  );
}
