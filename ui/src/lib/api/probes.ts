import type { Probe } from "./client.ts";
import { routes } from "./routes.ts";

// The probe set of each screen that offers actions a server may lack; see probe() for why each is safe.
export const accountProbes: readonly Probe[] = [
  { route: routes.uploadCredentials },
  { route: routes.refreshCredentials },
  { route: routes.setCredentialStatus },
  { route: routes.setCredentialFields },
  { route: routes.deleteCredentials },
  { route: routes.resetCooldown },
  { route: routes.callProvider },
];

export const connectProbes: readonly Probe[] = [
  { route: routes.startOAuth },
  { route: routes.importOAuth },
];

// count=0 fails validation, so probing never removes a record from the queue.
export const usageProbes: readonly Probe[] = [
  { route: routes.drainUsageQueue, query: { count: 0 } },
];
