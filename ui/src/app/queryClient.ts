import { QueryClient } from "@tanstack/react-query";
import { ConnectionError } from "../lib/api/client.ts";

// A read stays fresh for 30 s, so moving between pages shows the cached answer and does not
// refetch config and plugins on every entry; a list that polls sets its own staleTime and
// interval, and a refetch keeps the previous data on screen. A read is retried once only when no
// answer arrived; an answer from the server is final. Writes are never retried.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) =>
        count < 1 &&
        error instanceof ConnectionError &&
        (error.reason === "unreachable" || error.reason === "timeout"),
    },
    mutations: { retry: false },
  },
});
