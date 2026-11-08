import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { usePlugins } from "../../app/serverQueries.ts";
import { useAvailable } from "../../components/MissingActions.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { routes } from "../../lib/api/routes.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { builtIn } from "./flow.ts";
import type { SignIn } from "./useSignIn.ts";

/** The built-in providers at once, then each plugin provider that signs in with OAuth. */
export function ProviderList({ signIn }: { signIn: SignIn }) {
  const plugins = usePlugins();
  const canStart = useAvailable()(routes.startOAuth);
  const fromPlugins = (plugins.data?.plugins ?? [])
    .filter((p) => p.supports_oauth)
    .map((p) => p.oauth_provider || p.id);
  const providers = [...new Set([...builtIn, ...fromPlugins])];
  return (
    <VStack gap={4}>
      <Heading level={2}>{t("connect.providers.heading")}</Heading>
      <Text type="body" color="secondary">
        {t("connect.providers.description")}
      </Text>
      <List density="compact" hasDividers aria-busy={plugins.isPending}>
        {providers.map((p) => {
          const gone = signIn.gone.includes(p);
          const enabled = canStart && !gone;
          return (
            <ListItem
              key={p}
              label={label(p)}
              description={gone ? t("connect.providers.unavailable") : undefined}
              isDisabled={!enabled}
              isSelected={signIn.flow?.provider === p && signIn.flow.phase === "wait"}
              onClick={() => enabled && void signIn.start(p)}
              endContent={
                signIn.pending === p ? (
                  <Spinner size="sm" aria-label={t("connect.providers.starting")} />
                ) : (
                  <Icon icon="chevronRight" size="sm" color="secondary" />
                )
              }
            />
          );
        })}
        {plugins.isPending && (
          <ListItem
            label={
              <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
            }
          />
        )}
      </List>
      {plugins.isError && (
        <ReadError
          error={plugins.error}
          what={t("connect.providers.what")}
          retry={() => void plugins.refetch()}
        />
      )}
    </VStack>
  );
}
