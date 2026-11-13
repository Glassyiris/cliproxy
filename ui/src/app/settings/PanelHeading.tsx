// The open panel's heading in a settings-dialog frame (preferences, plugins). Opening the dialog
// focuses it, as Astryx's DialogHeader focuses its title, so a screen reader starts at the panel
// and the next Tab reaches the panel's first control rather than the rail's first item.

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Heading } from "@astryxdesign/core/Text";

const styles = stylex.create({
  // A heading is a reading position, not a control: no focus ring around it (DialogHeader's own
  // title style); the ring appears on the control a key press moves to.
  focusTarget: { outline: "none" },
});

export function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <Heading level={2} tabIndex={-1} data-autofocus xstyle={styles.focusTarget}>
      {children}
    </Heading>
  );
}
