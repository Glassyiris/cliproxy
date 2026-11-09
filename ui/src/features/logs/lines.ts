import type { ErrorLogFile, LogPage } from "../../lib/api/logs.ts";

/** One application log line; `key` stays with the line while the tail grows and is trimmed. */
export type LogLine = {
  key: number;
  text: string;
  /** Set when the line has the server's `[time] [request id] [level] message` shape. */
  parsed?: { time: string; requestId: string; level: string; message: string };
};

/** The lines this tab keeps and the cursor of the next read. */
export type Tail = { lines: LogLine[]; cursor: string; nextKey: number };

/** The newest lines a tab keeps. */
export const MAX_LINES = 1500;

// `[2026-11-08 12:00:00] [a1b2c3d4] [info ] [handler.go:42] message`; the source part is optional.
const SHAPE = /^\[([^\]]*)\] \[([^\]]*)\] \[(\w+)\s*\] (?:\[[^\]]*\] )?(.*)$/;

export function parseLine(text: string, key: number): LogLine {
  const m = SHAPE.exec(text);
  if (!m) return { key, text };
  // A line outside any request carries dashes where the id would be.
  const requestId = /[^-]/.test(m[2]) ? m[2] : "";
  return {
    key,
    text,
    parsed: { time: m[1].slice(11) || m[1], requestId, level: m[3].toLowerCase(), message: m[4] },
  };
}

/** `prev` with one more page: appended after it, or in its place when the cursor was stale. */
export function appendPage(prev: Tail | undefined, page: LogPage): Tail {
  const fresh = !prev || page["cursor-reset"] === true;
  const start = prev?.nextKey ?? 0;
  const cursor = page["next-cursor"];
  if (!fresh && !page.lines.length) return prev.cursor === cursor ? prev : { ...prev, cursor };
  const added = page.lines.map((text, i) => parseLine(text, start + i));
  const lines = fresh ? added : prev.lines.concat(added);
  return {
    lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines,
    cursor,
    nextKey: start + added.length,
  };
}

// The dashboard's own reads (this tail among them) go through the Management API.
const isManagementCall = (line: LogLine) => line.text.includes("/management/");

/** The level filter: every line, warnings and worse, or errors and worse (logrus levels). */
export type LevelFilter = "" | "warn" | "error";

const AT_LEAST: Record<Exclude<LevelFilter, "">, ReadonlySet<string>> = {
  error: new Set(["error", "fatal", "panic"]),
  warn: new Set(["warn", "warning", "error", "fatal", "panic"]),
};

/**
 * The lines to show: management calls only when asked for, lines of `level` or worse when set
 * (a line without a level is then left out), then those containing `filter`.
 */
export function shownLines(
  lines: LogLine[],
  filter: string,
  withManagement: boolean,
  level: LevelFilter = "",
) {
  const needle = filter.trim().toLowerCase();
  const levels = level ? AT_LEAST[level] : null;
  if (!needle && withManagement && !levels) return lines;
  return lines.filter(
    (l) =>
      (withManagement || !isManagementCall(l)) &&
      (!levels || levels.has(l.parsed?.level ?? "")) &&
      (!needle || l.text.toLowerCase().includes(needle)),
  );
}

/** The error log files whose name contains `filter`, ignoring case. */
export function filesMatching(files: ErrorLogFile[], filter: string) {
  const needle = filter.trim().toLowerCase();
  return needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files;
}
