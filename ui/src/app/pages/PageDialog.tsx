// An earlier page hosted unchanged in a dialog (DESIGN.md "Routes"), on the form-wizard-dialog
// template's frame: Dialog `purpose="form"`, a fill Layout with padding 4 and dividers, the
// DialogHeader with the close button, the page in the content. The dialog is `?open=<id>` on the
// route, so Back, reload and links reach it. Deviation: 800 wide, not the template's 620, because
// the hosted pages were laid out for a page's reading width (roles.content.formWidth).

import { Suspense, type ReactNode } from "react";
import { Center } from "@astryxdesign/core/Center";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { PageHostContext } from "../pageHost.ts";
import { useHashParams } from "../useHashRoute.ts";

/**
 * Whether the dialog `id` is open, and opening and closing it. Closing also drops `own`, the query
 * keys the hosted page keeps (its step, its open item), so the next opening starts clean.
 */
export function useDialogParam(id: string, own: readonly string[] = []) {
  const [params, setParams] = useHashParams();
  return {
    isOpen: params.open === id,
    open: () => setParams({ open: id }, "push"),
    close: () =>
      setParams(Object.fromEntries(["open", ...own].map((key) => [key, undefined])), "push"),
  };
}

export function PageDialog({
  isOpen,
  title,
  onClose,
  children,
}: {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const onOpenChange = (open: boolean) => !open && onClose();
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      width={roles.content.formWidth}
      purpose="form"
    >
      <Layout
        height="fill"
        padding={4}
        defaultHasDividers
        header={<DialogHeader title={title} onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            <PageHostContext value={{ kind: "dialog" }}>
              <Suspense
                fallback={
                  <Center axis="both" padding={10}>
                    <Spinner aria-label={t("app.read.loading", { what: title })} />
                  </Center>
                }
              >
                {isOpen && children}
              </Suspense>
            </PageHostContext>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
