import { useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Center } from "@astryxdesign/core/Center";
import {
  InternationalizationProvider,
  type ProviderMessagesByLocale,
} from "@astryxdesign/core/i18n";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Theme, type DefinedTheme } from "@astryxdesign/core/theme";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { setLocale as selectLocale, t, type Locale } from "../lib/i18n.ts";
import { notify } from "../lib/notify.ts";
import { defaultPalette, loadPalette, siteTheme, type Palette } from "../themes/site/index.ts";
import { ToastBridge } from "./Notices.tsx";
import {
  astryxMessages,
  initialLocale,
  initialMode,
  PreferencesContext,
  storeLocale,
  storeMode,
  storePalette,
  type ThemeMode,
} from "./preferences.ts";
import { QuotaProvider } from "./QuotaProvider.tsx";
import { queryClient } from "./queryClient.ts";
import { SessionProvider, useSession } from "./Session.tsx";
import { Shell } from "./Shell.tsx";
import { SignIn } from "./SignIn.tsx";

/** How long a stored-key check shows only the page background, so a quick one does not flash. */
const QUIET_WAIT = 400;

/** While a stored key is checked: the page background, then a spinner naming the server. */
function RestoreWait() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), QUIET_WAIT);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <Center axis="both" minHeight="100dvh">
      <Spinner label={t("app.signIn.restoring", { host: location.host })} />
    </Center>
  );
}

/** Shell or sign-in; neither shows while a stored key is checked, so the wrong one never flashes. */
function Gate() {
  const { signedIn, restoring } = useSession();
  if (restoring) return <RestoreWait />;
  return signedIn ? (
    <QuotaProvider>
      <Shell />
    </QuotaProvider>
  ) : (
    <SignIn />
  );
}

type ShownPalette = { name: Palette; theme: DefinedTheme };

/** Providers, in order: data, Astryx strings, theme, preferences, toasts, session. */
export function App({
  messages: initialMessages,
  palette: initialPalette,
}: {
  messages: ProviderMessagesByLocale;
  palette: ShownPalette;
}) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const [palette, setPalette] = useState(initialPalette);
  const wantedPalette = useRef(palette.name);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState(initialMessages);
  // Only the latest locale the user picked may commit; an older load that resolves later is dropped.
  const wantedLocale = useRef(locale);
  // t() reads the module's locale; setting it here, before the tree renders, keeps both in step.
  selectLocale(locale);

  const preferences = {
    mode,
    palette: palette.name,
    locale,
    setMode(next: ThemeMode) {
      setMode(next);
      storeMode(next);
    },
    // A palette shows once its theme is in; one that fails to load leaves the default shown.
    setPalette(next: Palette) {
      wantedPalette.current = next;
      void loadPalette(next).then((theme) => {
        if (wantedPalette.current !== next) return;
        if (!theme) {
          notify("error", t("app.colors.failed"));
          setPalette({ name: defaultPalette, theme: siteTheme });
          return;
        }
        setPalette({ name: next, theme });
        storePalette(next);
      });
    },
    setLocale(next: Locale) {
      wantedLocale.current = next;
      void astryxMessages(next).then((loaded) => {
        if (wantedLocale.current !== next) return;
        setMessages((m) => ({ ...m, ...loaded }));
        setLocale(next);
        storeLocale(next);
      });
    },
  };

  return (
    <QueryClientProvider client={queryClient}>
      <InternationalizationProvider locale={locale} messages={messages}>
        <Theme theme={palette.theme} mode={mode}>
          <PreferencesContext value={preferences}>
            <ToastViewport position="bottomEnd" maxVisible={1}>
              <ToastBridge />
              <SessionProvider>
                <Gate />
              </SessionProvider>
            </ToastViewport>
          </PreferencesContext>
        </Theme>
      </InternationalizationProvider>
    </QueryClientProvider>
  );
}
