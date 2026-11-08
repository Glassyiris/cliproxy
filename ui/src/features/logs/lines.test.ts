import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LogPage } from "../../lib/api/logs.ts";
import { appendPage, MAX_LINES, parseLine, shownLines } from "./lines.ts";

const page = (lines: string[], cursor: string, reset = false): LogPage => ({
  lines,
  "line-count": lines.length,
  "latest-timestamp": 0,
  "next-cursor": cursor,
  ...(reset ? { "cursor-reset": true as const } : {}),
});
const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

test("parse: the server's shape with and without a source part; dashes are no request id", () => {
  assert.deepEqual(
    parseLine("[2026-11-08 12:00:01] [a1b2c3d4] [warn ] [handler.go:42] cooling", 0).parsed,
    { time: "12:00:01", requestId: "a1b2c3d4", level: "warn", message: "cooling" },
  );
  assert.deepEqual(parseLine("[2026-11-08 12:00:02] [--------] [INFO] started", 1).parsed, {
    time: "12:00:02",
    requestId: "",
    level: "info",
    message: "started",
  });
  assert.equal(parseLine("panic: boom", 2).parsed, undefined);
});

test("append: lines follow the previous ones; a reset starts over; the newest are kept", () => {
  const first = appendPage(undefined, page(["a", "b"], "c2"));
  assert.deepEqual(texts(first.lines), ["a", "b"]);
  const next = appendPage(first, page(["c"], "c3"));
  assert.deepEqual(texts(next.lines), ["a", "b", "c"]);
  assert.deepEqual(
    next.lines.map((l) => l.key),
    [0, 1, 2],
  );
  assert.equal(next.cursor, "c3");
  const reset = appendPage(next, page(["x"], "c1", true));
  assert.deepEqual(texts(reset.lines), ["x"]);
  assert.equal(reset.lines[0].key, 3);
  const many = appendPage(
    reset,
    page(
      Array.from({ length: MAX_LINES }, (_, i) => String(i)),
      "c9",
    ),
  );
  assert.equal(many.lines.length, MAX_LINES);
  assert.equal(many.lines[0].text, "0");
});

test("append: an empty page keeps the same tail unless the cursor moved", () => {
  const tail = appendPage(undefined, page(["a"], "c1"));
  assert.equal(appendPage(tail, page([], "c1")), tail);
  assert.equal(appendPage(tail, page([], "c2")).cursor, "c2");
});

test("shown: management calls only when asked for; the filter ignores case", () => {
  const lines = ["GET /v0/management/logs", "POST /v1/messages", "upstream Error 502"].map((t, i) =>
    parseLine(t, i),
  );
  assert.deepEqual(texts(shownLines(lines, "", false)), [
    "POST /v1/messages",
    "upstream Error 502",
  ]);
  assert.equal(shownLines(lines, "", true), lines);
  assert.deepEqual(texts(shownLines(lines, " error ", true)), ["upstream Error 502"]);
  assert.deepEqual(texts(shownLines(lines, "logs", false)), []);
});
