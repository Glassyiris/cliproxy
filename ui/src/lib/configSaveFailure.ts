import { ApiError } from "./api/client.ts";
import { t } from "./i18n.ts";

export type ConfigSaveFailure = { draft: string; message: string };

/** A destination change needs fresh secrets, without discarding the reviewed JSON. */
export function configSaveFailure(error: unknown, draft: string): ConfigSaveFailure | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 422 ||
    error.code !== "secret_destination_changed"
  )
    return null;
  return {
    draft,
    message: t("app.editor.reenterSecrets", {
      resource: error.resource ?? "",
      pointers: error.pointers.join(", "),
    }),
  };
}
