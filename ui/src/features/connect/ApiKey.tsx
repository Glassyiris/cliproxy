import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { families, familyName, isFamily, type Family } from "../../components/keyFamilies.ts";
import { providerIcon } from "../../components/ProviderIcon.tsx";
import { t } from "../../lib/i18n.ts";

/** The Provider keys tab with the add form of `family` open. */
export const addKeysHref = (family: Family) => `#accounts?view=providers&add=${family}`;

/** Step 2 for an API key: the provider family; the key itself is entered in Provider keys. */
export function ApiKeyFamily({
  family,
  onChange,
}: {
  family: Family;
  onChange: (family: Family) => void;
}) {
  return (
    <FormLayout>
      <Selector
        label={t("connect.apiKey.family")}
        options={families.map((f) => ({ value: f, label: familyName(f), icon: providerIcon(f) }))}
        value={family}
        onChange={(value) => isFamily(value) && onChange(value)}
      />
      <Text type="supporting" color="secondary">
        {t("connect.apiKey.note")}
      </Text>
    </FormLayout>
  );
}
