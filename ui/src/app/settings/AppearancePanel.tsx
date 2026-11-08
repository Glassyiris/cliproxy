import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Languages, Palette as PaletteIcon, SunMoon } from "lucide-react";
import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Theme, type DefinedTheme } from "@astryxdesign/core/theme";
import { isLocale, localeName, locales, t } from "../../lib/i18n.ts";
import {
  defaultPalette,
  defaultTheme,
  loadPalette,
  type Palette,
} from "../../themes/site/index.ts";
import { usePreferences, type ThemeMode } from "../preferences.ts";
import { SettingsCard, SettingsRow } from "./SettingsRows.tsx";
import { layout } from "../../themes/site/layout.ts";

const preview = stylex.create({
  clip: {
    overflow: "hidden",
    borderRadius: "var(--radius-element)",
  },
  page: {
    backgroundColor: "var(--color-background-body)",
  },
  surface: {
    backgroundColor: "var(--color-background-surface)",
  },
  inert: {
    pointerEvents: "none",
  },
});

const PALETTES: { value: Palette; label: () => string }[] = [
  { value: "neutral", label: () => t("app.colors.neutral") },
  { value: "moon", label: () => t("app.colors.moon") },
  { value: "main", label: () => t("app.colors.main") },
];

/** A palette's theme; Neutral is in the entry, the others load on first use (null while loading or failed). */
function usePaletteTheme(palette: Palette) {
  const [theme, setTheme] = useState<DefinedTheme | null>(
    palette === defaultPalette ? defaultTheme : null,
  );
  useEffect(() => {
    let isCurrent = true;
    void loadPalette(palette).then((loaded) => {
      if (isCurrent) setTheme(loaded);
    });
    return () => {
      isCurrent = false;
    };
  }, [palette]);
  return theme;
}

/**
 * The palette in one mode, drawn with real components under a nested Theme: the page, a surface,
 * text in both weights and the three status hues. A nested Theme re-declares the tokens for its
 * mode, so the Dawn half stays light in a dark app.
 */
function PreviewCanvas({ theme, mode }: { theme: DefinedTheme; mode: "light" | "dark" }) {
  return (
    <Theme theme={theme} mode={mode}>
      <VStack padding={2} gap={1.5} height="100%" xstyle={preview.page}>
        <Text type="supporting" weight="semibold" maxLines={1} hasTruncateTooltip={false}>
          {t("app.brand.name")}
        </Text>
        <StackItem size="fill">
          <VStack padding={2} gap={1} vAlign="center" height="100%" xstyle={preview.surface}>
            <HStack gap={1} vAlign="center">
              <StatusDot variant="success" label={t("app.credState.ready")} />
              <StatusDot variant="warning" label={t("app.credState.unavailable")} />
              <StatusDot variant="error" label={t("app.credState.error")} />
            </HStack>
            <Text type="supporting" color="secondary" maxLines={1} hasTruncateTooltip={false}>
              {t("app.nav.accounts")}
            </Text>
          </VStack>
        </StackItem>
      </VStack>
    </Theme>
  );
}

/** Light on the start half, dark on the end half: a palette is a pair, and both halves are live. */
function PalettePreview({ palette }: { palette: Palette }) {
  const theme = usePaletteTheme(palette);
  return (
    <AspectRatio ratio={3 / 2} xstyle={preview.inert}>
      <HStack aria-hidden="true" gap={0} height="100%" xstyle={preview.clip}>
        {theme && (
          <>
            <StackItem size="fill">
              <PreviewCanvas theme={theme} mode="light" />
            </StackItem>
            <StackItem size="fill">
              <PreviewCanvas theme={theme} mode="dark" />
            </StackItem>
          </>
        )}
      </HStack>
    </AspectRatio>
  );
}

/**
 * The palettes as pictures, as the template's theme cards. SelectableCard is a checkbox, so the
 * group is named by the radiogroup around it and a card only ever selects.
 */
function PaletteCards() {
  const { palette, setPalette } = usePreferences();
  return (
    <Grid
      role="radiogroup"
      aria-label={t("app.colors.label")}
      columns={{ minWidth: layout.settingsDialog.previewMin, max: PALETTES.length }}
      gap={2}
      maxWidth={layout.settingsDialog.previewsMax}
    >
      {PALETTES.map((choice) => {
        const isSelected = choice.value === palette;
        return (
          <SelectableCard
            key={choice.value}
            label={choice.label()}
            isSelected={isSelected}
            padding={2}
            onChange={() => {
              if (!isSelected) setPalette(choice.value);
            }}
          >
            <VStack gap={1.5}>
              <PalettePreview palette={choice.value} />
              <HStack hAlign="center">
                <Text type="supporting" weight={isSelected ? "semibold" : "normal"}>
                  {choice.label()}
                </Text>
              </HStack>
            </VStack>
          </SelectableCard>
        );
      })}
    </Grid>
  );
}

const MODES: { value: ThemeMode; label: () => string }[] = [
  { value: "system", label: () => t("app.settings.modeSystem") },
  { value: "light", label: () => t("app.settings.modeLight") },
  { value: "dark", label: () => t("app.settings.modeDark") },
];

const isMode = (value: string): value is ThemeMode => MODES.some((m) => m.value === value);

export function AppearancePanel() {
  const { mode, setMode, locale, setLocale } = usePreferences();
  return (
    <SettingsCard>
      <SettingsRow
        title={t("app.colors.label")}
        icon={PaletteIcon}
        description={t("app.settings.paletteHint")}
        detail={<PaletteCards />}
      />
      <SettingsRow
        title={t("app.settings.mode")}
        icon={SunMoon}
        control={
          <SegmentedControl
            label={t("app.settings.mode")}
            size="sm"
            value={mode}
            onChange={(value) => isMode(value) && setMode(value)}
          >
            {MODES.map((m) => (
              <SegmentedControlItem key={m.value} value={m.value} label={m.label()} />
            ))}
          </SegmentedControl>
        }
      />
      <SettingsRow
        title={t("app.locale.label")}
        icon={Languages}
        control={
          <SegmentedControl
            label={t("app.locale.label")}
            size="sm"
            value={locale}
            onChange={(value) => isLocale(value) && setLocale(value)}
          >
            {locales.map((l) => (
              <SegmentedControlItem key={l} value={l} label={localeName(l)} />
            ))}
          </SegmentedControl>
        }
      />
    </SettingsCard>
  );
}
