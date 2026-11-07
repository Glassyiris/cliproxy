import type { SVGProps } from "react";

// The dashboard's one icon set: 24-unit line glyphs drawn in currentColor. Astryx's own semantic
// icons (close, check, externalLink …) cover the rest. Icon sizes them.
type Glyph = SVGProps<SVGSVGElement>;

const line = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const ServerIcon = (props: Glyph) => (
  <svg {...line} {...props}>
    <path d="M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01" />
  </svg>
);

export const SunIcon = (props: Glyph) => (
  <svg {...line} {...props}>
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5" />
  </svg>
);

export const MoonIcon = (props: Glyph) => (
  <svg {...line} {...props}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5" />
  </svg>
);

export const ContrastIcon = (props: Glyph) => (
  <svg {...line} {...props}>
    <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 3v18" />
  </svg>
);

export const LanguageIcon = (props: Glyph) => (
  <svg {...line} {...props}>
    <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9M12 3C9.5 5.6 8.3 8.6 8.3 12s1.2 6.4 3.7 9" />
  </svg>
);

export const SignOutIcon = (props: Glyph) => (
  <svg {...line} {...props}>
    <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />
  </svg>
);

// The switchboard mark: a ring of jacks around one live line.
export const BrandIcon = (props: Glyph) => (
  <svg {...line} {...props}>
    <path
      d="M5 5h.01M12 5h.01M19 5h.01M5 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01"
      strokeWidth={3.5}
    />
    <path d="M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5" />
  </svg>
);
