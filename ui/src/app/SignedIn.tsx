import { QuotaProvider } from "./QuotaProvider.tsx";
import { Shell } from "./Shell.tsx";

/** The app after sign-in, its own chunk (chunks.ts). */
export default function SignedIn() {
  return (
    <QuotaProvider>
      <Shell />
    </QuotaProvider>
  );
}
