import { Component, type ErrorInfo, type ReactNode } from "react";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { t } from "../lib/i18n.ts";
import { PageLoadError } from "./chunks.ts";

/**
 * Catches a page that failed to render or to load its chunk, so the shell stays up and the page
 * shows an error with a retry instead of the whole app unmounting. Retry clears failed queries and
 * renders the page again; a chunk that failed to load offers a reload instead, since retrying
 * cannot fetch it. `resetKey` (the route) clears the error when the user moves on.
 */
function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  const chunk = error instanceof PageLoadError;
  return (
    <VStack padding={6} role="alert">
      <EmptyState
        title={t("app.page.failedTitle")}
        description={chunk ? t("app.page.chunkFailedDescription") : t("app.page.failedDescription")}
        icon={<Icon icon="error" size="lg" color="secondary" />}
        actions={
          chunk ? (
            <Button
              label={t("app.page.reload")}
              variant="secondary"
              onClick={() => location.reload()}
            />
          ) : (
            <Button label={t("app.read.retry")} variant="secondary" onClick={retry} />
          )
        }
      />
    </VStack>
  );
}

type CatcherProps = { resetKey: string; onReset: () => void; children: ReactNode };
type CatcherState = { error: unknown; resetKey: string };

class Catcher extends Component<CatcherProps, CatcherState> {
  state: CatcherState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: CatcherProps, state: CatcherState) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn("Page failed", error, info.componentStack);
  }

  retry = () => {
    this.props.onReset();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    return error ? <PageError error={error} retry={this.retry} /> : this.props.children;
  }
}

export function QueryBoundary({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const { reset } = useQueryErrorResetBoundary();
  return (
    <Catcher resetKey={resetKey} onReset={reset}>
      {children}
    </Catcher>
  );
}
