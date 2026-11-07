import { QueryClient } from "@tanstack/react-query";
import { ConnectionError } from "../lib/api/client.ts";

// No app-wide staleTime: each list sets its own to match its polling interval. A read is retried
// once only when no answer arrived; an answer from the server is final. Writes are never retried.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        count < 1 &&
        error instanceof ConnectionError &&
        (error.reason === "unreachable" || error.reason === "timeout"),
    },
    mutations: { retry: false },
  },
});
