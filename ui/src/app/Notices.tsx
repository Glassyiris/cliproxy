import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { useToast, type ToastDismissFn } from "@astryxdesign/core/Toast";
import { t } from "../lib/i18n.ts";
import { onDismissNotice, onNotice, placement, type Notice } from "../lib/notify.ts";

/**
 * Shows success, info and error notices as toasts and takes one down on request; PageWarning
 * shows warnings.
 */
export function ToastBridge() {
  const show = useToast();
  useEffect(() => {
    const shown = new Map<number, ToastDismissFn>();
    const stopShowing = onNotice(({ id, level, message }) => {
      const where = placement(level);
      if (where.surface !== "toast") return;
      const hide = () => void shown.delete(id);
      shown.set(
        id,
        show({ body: message, type: where.type, isAutoHide: where.autoHide, onHide: hide }),
      );
    });
    const stopDismissing = onDismissNotice((id) => {
      shown.get(id)?.();
      shown.delete(id);
    });
    return () => {
      stopShowing();
      stopDismissing();
    };
  }, [show]);
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
