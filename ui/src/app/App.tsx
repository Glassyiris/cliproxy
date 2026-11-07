import { useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  InternationalizationProvider,
  type ProviderMessagesByLocale,
} from "@astryxdesign/core/i18n";
import { Theme } from "@astryxdesign/core/theme";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { setLocale as selectLocale, type Locale } from "../lib/i18n.ts";
import { siteTheme } from "../themes/site/index.ts";
import { ToastBridge } from "./Notices.tsx";
import {
  astryxMessages,
  initialLocale,
  initialMode,
  PreferencesContext,
  storeLocale,
  storeMode,
  type ThemeMode,
} from "./preferences.ts";
import { queryClient } from "./queryClient.ts";
import { SessionProvider, useSession } from "./Session.tsx";
import { Shell } from "./Shell.tsx";
import { SignIn } from "./SignIn.tsx";

function Gate() {
  return useSession().signedIn ? <Shell /> : <SignIn />;
}

/** Providers, in order: data, Astryx strings, theme, preferences, toasts, session. */
export function App({ messages: initialMessages }: { messages: ProviderMessagesByLocale }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState(initialMessages);
  // Only the latest locale the user picked may commit; an older load that resolves later is dropped.
  const wantedLocale = useRef(locale);
  // t() reads the module's locale; setting it here, before the tree renders, keeps both in step.
  selectLocale(locale);

  const preferences = {
    mode,
    locale,
    setMode(next: ThemeMode) {
      setMode(next);
      storeMode(next);
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
        <Theme theme={siteTheme} mode={mode}>
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
