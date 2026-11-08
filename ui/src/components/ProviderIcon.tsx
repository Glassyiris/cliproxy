// The one place a brand mark is drawn: each mark of providerMarks.ts becomes an SVG component that
// Astryx Icon sizes and colours like a lucide one. A provider with no mark gets lucide's Bot.
import type { ReactNode, SVGProps } from "react";
import { Icon, type IconProps, type IconType } from "@astryxdesign/core/Icon";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Bot } from "lucide-react";
import { markOf, pathsOf, type Mark } from "./providerMarks.ts";

const glyphs = new Map<Mark, IconType>();

function glyphOf(mark: Mark): IconType {
  let glyph = glyphs.get(mark);
  if (!glyph) {
    const paths = pathsOf(mark);
    glyph = (props: SVGProps<SVGSVGElement>) => (
      <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" {...props}>
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
    glyphs.set(mark, glyph);
  }
  return glyph;
}

/** The icon component for a provider id, for a slot that takes one (menu items, options). */
export function providerIcon(provider: string): IconType {
  const mark = markOf(provider);
  return mark ? glyphOf(mark) : Bot;
}

type LabelProps = {
  provider: string;
  children: ReactNode;
  /** The icon's size, matching the text beside it: sm beside body text, xsm beside supporting. */
  size?: IconProps["size"];
  color?: IconProps["color"];
};

/** A provider's name with its mark before it; the mark is decorative, the name stays the text. */
export function ProviderLabel({ provider, children, size = "sm", color }: LabelProps) {
  return (
    <HStack gap={1.5} vAlign="center" wrap="nowrap">
      <Icon icon={providerIcon(provider)} size={size} color={color} />
      <StackItem size="fill">{children}</StackItem>
    </HStack>
  );
}
