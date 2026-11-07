import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { useToast } from "@astryxdesign/core/Toast";
import { t } from "../lib/i18n.ts";
import { onNotice, placement, type Notice } from "../lib/notify.ts";

/** Shows success, info and error notices as toasts; PageWarning shows warnings. */
export function ToastBridge() {
  const show = useToast();
  useEffect(
    () =>
      onNotice(({ level, message }) => {
        const where = placement(level);
        if (where.surface === "toast")
          show({ body: message, type: where.type, isAutoHide: where.autoHide });
      }),
    [show],
  );
  return null;
}

/** The latest warning, as a banner above the page. The shell remounts it on every page change. */
export function PageWarning() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => onNotice((n) => placement(n.level).surface === "banner" && setNotice(n)), []);
  if (!notice) return null;
  return (
    <Banner
      key={notice.id}
      status="warning"
      container="section"
      title={notice.message}
      isDismissable
      dismissLabel={t("app.notice.dismiss")}
      onDismiss={() => setNotice(null)}
    />
  );
}
