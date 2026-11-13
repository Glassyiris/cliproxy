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
import { defaultPalette, defaultTheme, loadPalette, type Palette } from "../themes/site/index.ts";
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
import { loadedSignedIn, loadSignedIn, PageLoadError, preloadSignedIn } from "./chunks.ts";
import { QueryBoundary } from "./QueryBoundary.tsx";
import { queryClient } from "./queryClient.ts";
import { SessionProvider, useSession } from "./Session.tsx";
import { SignIn } from "./SignIn.tsx";

// The session cookie is checked before anything shows; the shell and page load in the meantime.
preloadSignedIn();

/** How long a session check shows only the page background, so a quick one does not flash. */
const QUIET_WAIT = 400;

/** While the session cookie is checked: the page background, then a spinner naming the server. */
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

/**
 * The shell once its chunk and the current page's are in; until then the restore wait goes on.
 * State, not Suspense: a revealed boundary is held back for up to 300 ms. A failed load is thrown
 * to the boundary around it.
 */
function SignedIn() {
  const [shell, setShell] = useState(loadedSignedIn);
  const [failed, setFailed] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (shell) return;
    let live = true;
    loadSignedIn().then(
      (module) => live && setShell(module),
      (cause: unknown) =>
        live && setFailed({ error: new PageLoadError("Shell chunk failed to load", { cause }) }),
    );
    return () => {
      live = false;
    };
  }, [shell]);
  if (failed) throw failed.error;
  return shell ? <shell.default /> : <RestoreWait />;
}

/** Shell or sign-in; neither shows while the session cookie is checked, so the wrong one never flashes. */
function Gate() {
  const { signedIn, restoring } = useSession();
  if (restoring) return <RestoreWait />;
  return signedIn ? (
    <QueryBoundary resetKey="signed-in">
      <SignedIn />
    </QueryBoundary>
  ) : (
    <SignIn />
  );
}

type ShownPalette = { name: Palette; theme: DefinedTheme };

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
          setPalette({ name: defaultPalette, theme: defaultTheme });
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
