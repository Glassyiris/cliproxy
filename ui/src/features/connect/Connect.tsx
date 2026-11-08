import { Divider } from "@astryxdesign/core/Divider";
import { VStack } from "@astryxdesign/core/Layout";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useAction } from "../../app/useAction.ts";
import { MissingActions } from "../../components/MissingActions.tsx";
import { routes } from "../../lib/api/routes.ts";
import { t } from "../../lib/i18n.ts";
import { OtherWays } from "./OtherWays.tsx";
import { ProviderList } from "./ProviderList.tsx";
import { SignInPanel } from "./SignInPanel.tsx";
import { useSignIn } from "./useSignIn.ts";

export default function Connect() {
  const action = useAction();
  const signIn = useSignIn(action);
  return (
    <PageFrame title={t("connect.page.title")}>
      <MissingActions
        actions={[
          { route: routes.startOAuth, label: t("connect.missing.signIn") },
          { route: routes.importOAuth, label: t("connect.missing.vertex") },
        ]}
      />
      <VStack gap={4}>
        <ProviderList signIn={signIn} />
        <SignInPanel signIn={signIn} />
      </VStack>
      <Divider />
      <OtherWays action={action} />
    </PageFrame>
  );
}
