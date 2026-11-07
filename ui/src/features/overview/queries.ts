import { useQuery } from "@tanstack/react-query";
import { listErrorLogs } from "../../lib/api/logs.ts";

const overviewKeys = {
  errorLogs: ["overview", "error-logs"] as const,
};

/** Read once when the page opens; Logs keeps its own list. */
export const useErrorLogs = () =>
  useQuery({ queryKey: overviewKeys.errorLogs, queryFn: ({ signal }) => listErrorLogs(signal) });
