import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ApiError, ConnectionError } from "../lib/api/client.ts";
import { t } from "../lib/i18n.ts";

const errorText = (error: unknown) =>
  error instanceof ConnectionError
    ? error.reason === "timeout"
      ? t("app.connection.timeout")
      : t("app.connection.unreachable")
    : error instanceof Error
      ? error.message
      : String(error);

/** A read that failed, or a route this server does not implement. */
export function ReadError({
  error,
  what,
  retry,
}: {
  error: unknown;
  what: string;
  retry: () => void;
}) {
  if (error instanceof ApiError && error.notImplemented)
    return (
      <Banner
        status="info"
        title={t("app.read.unavailable")}
        description={t("app.read.unimplemented", {
          method: error.method,
          path: error.path,
          status: error.status,
        })}
      />
    );
  return (
    <Banner
      status="error"
      title={t("app.read.failed", { what })}
      description={errorText(error)}
      endContent={
        <Button label={t("app.read.retry")} variant="secondary" size="sm" onClick={retry} />
      }
    />
  );
}
