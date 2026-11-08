import type { IconProps } from "@astryxdesign/core/Icon";
import { Kbd } from "@astryxdesign/core/Kbd";
import { t } from "../../lib/i18n.ts";
import { SettingsCard, SettingsRow } from "./SettingsRows.tsx";

/** The dashboard's keyboard shortcuts. The shell binds these keys, so the list cannot drift. */
export const shortcuts = {
  goToPage: "mod+k",
} as const;

const ROWS: { keys: string; label: () => string; icon: IconProps["icon"] }[] = [
  { keys: shortcuts.goToPage, label: () => t("app.palette.label"), icon: "search" },
];

/**
 * The template's shortcuts panel, read-only: the dashboard has no rebinding or switching off, so
 * each row is the action and its keys.
 */
export function ShortcutsPanel() {
  return (
    <SettingsCard>
      {ROWS.map((r) => (
        <SettingsRow key={r.keys} title={r.label()} icon={r.icon} control={<Kbd keys={r.keys} />} />
      ))}
    </SettingsCard>
  );
}
