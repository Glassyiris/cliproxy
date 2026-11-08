// The template's filter row for the application log: the filter leads, the management calls
// switch beside it, then Clear and the request lookup; it wraps on a narrow screen.
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { Action } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";

export type Filters = { filter: string; withManagement: boolean };

/** Clear, after the question; the dialog stays open and busy until the server answers. */
function ClearButton({
  action,
  canClear,
  onClear,
  onWithdrawn,
}: {
  action: Action;
  canClear: boolean;
  onClear: () => Promise<void>;
  onWithdrawn: () => void;
}) {
  const [isAsking, setIsAsking] = useState(false);
  const [isWithdrawn, setIsWithdrawn] = useState(false);
  // A first empty 404 marks Clear unavailable: the question goes with it, and the focus it would
  // hand back to the disabled button goes elsewhere.
  if (isAsking && !canClear && !action.busy) {
    setIsAsking(false);
    setIsWithdrawn(true);
  }
  useEffect(() => {
    if (isWithdrawn) onWithdrawn();
  }, [isWithdrawn, onWithdrawn]);
  return (
    <>
      <Button
        label={t("logs.clear.button")}
        variant="destructive"
        isDisabled={!canClear}
        onClick={() => setIsAsking(true)}
      />
      <AlertDialog
        isOpen={isAsking}
        onOpenChange={(open) => !open && !action.busy && setIsAsking(false)}
        title={t("logs.clear.title")}
        description={t("logs.clear.description")}
        actionLabel={t("logs.clear.action")}
        cancelLabel={t("logs.clear.cancel")}
        isActionLoading={action.busy}
        onAction={async () => {
          if (action.busy || !canClear) return;
          if (await action.run(onClear, t("logs.clear.done"))) setIsAsking(false);
        }}
      />
    </>
  );
}

/** A request ID typed or pasted from the X-Request-Id header, opened in the panel. */
function RequestLookup({ openId, onOpen }: { openId: string; onOpen: (id: string) => void }) {
  const [value, setValue] = useState(openId);
  const [isMissing, setIsMissing] = useState(false);
  const [shown, setShown] = useState(openId);
  const field = useRef<HTMLDivElement>(null);
  // A link from a line or from Usage opens another request: the field shows its ID.
  if (openId !== shown) {
    setShown(openId);
    if (openId) setValue(openId);
  }
  const open = () => {
    const id = value.trim();
    setIsMissing(!id);
    if (id) onOpen(id);
    else field.current?.querySelector("input")?.focus();
  };
  return (
    <HStack gap={2} vAlign="start" ref={field}>
      <TextInput
        label={t("logs.request.label")}
        isLabelHidden
        placeholder={t("logs.request.label")}
        value={value}
        onChange={(v) => {
          setValue(v);
          if (v.trim()) setIsMissing(false);
        }}
        onEnter={open}
        status={isMissing ? { type: "error", message: t("logs.request.missing") } : undefined}
      />
      <Button label={t("logs.request.open")} onClick={open} />
    </HStack>
  );
}

export function Toolbar({
  ref,
  filters,
  setFilters,
  action,
  canClear,
  onClear,
  openId,
  onOpen,
}: {
  ref: Ref<HTMLDivElement>;
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
  action: Action;
  canClear: boolean;
  onClear: () => Promise<void>;
  openId: string;
  onOpen: (id: string) => void;
}) {
  const filter = useRef<HTMLElement>(null);
  const focusFilter = useCallback(() => filter.current?.querySelector("input")?.focus(), []);
  return (
    <HStack gap={3} vAlign="start" wrap="wrap" ref={ref}>
      <StackItem size="fill" ref={filter}>
        <TextInput
          type="search"
          label={t("logs.filters.filter")}
          isLabelHidden
          placeholder={t("logs.filters.filter")}
          value={filters.filter}
          onChange={(filter) => setFilters({ filter })}
          startIcon={<Icon icon="search" size="sm" />}
          hasClear
        />
      </StackItem>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <CheckboxInput
          label={t("logs.filters.management")}
          value={filters.withManagement}
          onChange={(withManagement) => setFilters({ withManagement })}
        />
        <ClearButton
          action={action}
          canClear={canClear}
          onClear={onClear}
          onWithdrawn={focusFilter}
        />
      </HStack>
      <RequestLookup openId={openId} onOpen={onOpen} />
    </HStack>
  );
}
