import { tools } from "../../lib/toolSetup.ts";

export type Tool = (typeof tools)[number];

const slug = (tool: Tool) => tool.toLowerCase().replaceAll(" ", "-");

/** The hash value of a tool, undefined for the first tool, which is what no value means. */
export const toolParam = (tool: Tool) => (tool === tools[0] ? undefined : slug(tool));

/** The tool a hash value names; anything unknown reads as the first tool. */
export const toolFromParam = (param: string | undefined): Tool =>
  tools.find((tool) => slug(tool) === param) ?? tools[0];
