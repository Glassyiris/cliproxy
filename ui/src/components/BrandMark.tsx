// The switchboard mark: a ring of jacks around one live line. The one drawn glyph; every other
// icon is a semantic name from the theme or a lucide component (gate: check-ui `icons`).

import type { SVGProps } from "react";

/** An Astryx icon component: Icon sets the size and colour, as for any lucide glyph. */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path
        d="M5 5h.01M12 5h.01M19 5h.01M5 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01"
        strokeWidth={3.5}
      />
      <path d="M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5" />
    </svg>
  );
}
