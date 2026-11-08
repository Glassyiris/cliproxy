// An earlier page hosted unchanged in a dialog (DESIGN.md "Routes"), on the form-wizard-dialog
// template's frame: Dialog `purpose="form"`, a fill Layout with padding 4 and dividers, the
// DialogHeader with the close button, the page in the content. A page can pin a part under the
// title (a wizard's stepper, in the template's second header row) and one at the foot (its
// buttons, in a LayoutFooter); only the content between them scrolls. The page's PageFrame hands
// its parts to the host's `frame`, so the hosted page keeps its state. The dialog keeps one height
// (layout.pageDialog) as the template's fixed-height rule asks, so it does not jump as a wizard's
// steps change. The dialog is `?open=<id>` on the route, so Back, reload and links reach it.
// Deviation: 800 wide, not the template's 620, because the hosted pages were laid out for a page's
// reading width (roles.content.formWidth).

import { Suspense, type ReactNode } from "react";
import { Center } from "@astryxdesign/core/Center";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  VStack,
} from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { PageHostContext, type DialogParts } from "../pageHost.ts";
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

/** The template's frame: the title row, then the pinned header part, the body, the footer. */
function frameOf(title: string, onOpenChange: (open: boolean) => void) {
  return function frame({ header, content, footer }: DialogParts) {
    return (
      <Layout
        height="fill"
        padding={4}
        defaultHasDividers
        header={
          <>
            {/* With a pinned part the two header rows read as one block, as in the template. */}
            <DialogHeader
              title={title}
              onOpenChange={onOpenChange}
              hasDivider={header ? false : undefined}
            />
            {header && <LayoutHeader hasDivider={false}>{header}</LayoutHeader>}
          </>
        }
        content={<LayoutContent>{content}</LayoutContent>}
        footer={footer && <LayoutFooter>{footer}</LayoutFooter>}
      />
    );
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
  const frame = frameOf(title, onOpenChange);
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      width={roles.content.formWidth}
      maxHeight={layout.pageDialog.height}
      purpose="form"
    >
      <VStack height={layout.pageDialog.height}>
        <PageHostContext value={{ kind: "dialog", frame }}>
          <Suspense
            fallback={frame({
              content: (
                <Center axis="both" padding={10}>
                  <Spinner aria-label={t("app.read.loading", { what: title })} />
                </Center>
              ),
            })}
          >
            {isOpen && children}
          </Suspense>
        </PageHostContext>
      </VStack>
    </Dialog>
  );
}
