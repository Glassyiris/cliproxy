// The in-page half of the measurement. Playwright serialises these functions into the page, so each
// one is self-contained and reads browser globals.
/* global document, getComputedStyle, innerHeight, innerWidth, requestAnimationFrame */

/**
 * Runs before the app: records every layout shift, and on every frame in which a skeleton is in the
 * page area, the box of the first region (the first block of the content column).
 */
export function installProbe() {
  const firstRegion = () => {
    let node = document.querySelector("[role=main] .astryx-layout-content");
    if (!node) return null;
    while (node.children.length === 1) node = node.children[0];
    return node.children[0] ?? node;
  };
  const state = { shifts: [], skeletonBox: null, firstRegion };
  // CLS as the browser reports it: the largest session of shifts at most 1 s apart and 5 s long.
  state.cls = (from) => {
    let cls = 0;
    let session = { value: 0, start: -Infinity, last: -Infinity };
    for (const shift of state.shifts.filter((entry) => entry.time >= from)) {
      if (shift.time - session.last > 1000 || shift.time - session.start > 5000)
        session = { value: 0, start: shift.time, last: shift.time };
      session.value += shift.value;
      session.last = shift.time;
      cls = Math.max(cls, session.value);
    }
    return Math.round(cls * 10000) / 10000;
  };
  globalThis.__measure = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      state.shifts.push({ value: entry.value, time: entry.startTime });
  }).observe({ type: "layout-shift", buffered: true });
  const tick = () => {
    const region = document.querySelector("[role=main] .astryx-skeleton") && firstRegion();
    if (region) {
      const box = region.getBoundingClientRect();
      state.skeletonBox = { top: box.top, left: box.left, width: box.width };
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function isReady() {
  const main = document.querySelector("[role=main]");
  return (
    !!main?.querySelector("h1") &&
    !main.querySelector("[aria-busy=true]") &&
    !main.querySelector(".astryx-skeleton")
  );
}

/**
 * The measurements of the page as rendered: role values (null when the page has no such element;
 * a button role lists every distinct height of its elements), the CLS since `from` (shifts within
 * 500 ms of the sign-in click count too: that input does not move this page), the first region's
 * move from skeleton to content (null when no skeleton was seen), and whether `answer` lies inside
 * the viewport (null without a selector).
 */
export function readPage({ from, answer }) {
  const state = globalThis.__measure;
  const main = document.querySelector("[role=main]");
  const round = (value) => Math.round(value * 10) / 10;
  const style = (selector) => {
    const element = main.querySelector(selector);
    return element ? getComputedStyle(element) : null;
  };
  const height = (selector) => {
    const element = main.querySelector(selector);
    return element ? round(element.getBoundingClientRect().height) : null;
  };
  const heights = (selector) => {
    const rendered = [...main.querySelectorAll(selector)].filter((e) => e.getClientRects().length);
    const values = new Set(rendered.map((e) => round(e.getBoundingClientRect().height)));
    return values.size ? [...values].sort((a, b) => a - b) : null;
  };
  const h1 = main.querySelector("h1");
  const content = style(".astryx-layout-content");

  const region = state.firstRegion()?.getBoundingClientRect();
  const before = state.skeletonBox;
  const inView = (selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return (
      !!box && box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
    );
  };
  const cards = [...main.querySelectorAll(".astryx-card, .astryx-clickable-card")].filter(
    (e) => e.getClientRects().length,
  );
  // The card's inset to its content: padding plus the hairline border (nbcards: 19 + 1).
  const inset = (e) => {
    const css = getComputedStyle(e);
    return `${parseFloat(css.paddingTop) + parseFloat(css.borderTopWidth)}px`;
  };
  const cardPaddings = new Set(cards.map(inset));
  return {
    h1Size: h1 ? getComputedStyle(h1).fontSize : null,
    h1Weight: h1 ? getComputedStyle(h1).fontWeight : null,
    h1Left: h1 ? round(h1.getBoundingClientRect().left) : null,
    h1Top: h1 ? round(h1.getBoundingClientRect().top) : null,
    hScroll: document.documentElement.scrollWidth - innerWidth,
    cardPadding: cardPaddings.size ? [...cardPaddings].sort() : null,
    // The start only: beside a panel Astryx narrows the content's end inset.
    contentInset: content ? content.paddingInlineStart : null,
    // Virtualized lists put an aria-hidden spacer row above the rows in view.
    tableRow: height("tbody tr:not([aria-hidden=true])"),
    primaryButton: heights(".astryx-layout-header .astryx-button[data-variant=primary]"),
    headerControl: heights(".astryx-layout-header .astryx-button:not([data-variant=primary])"),
    rowAction: heights("tbody .astryx-button"),
    cls: state.cls(from),
    // Position and width only: a list may grow past its skeleton rows, and what that growth
    // pushes is in the CLS.
    skeletonShift:
      before && region
        ? round(
            Math.max(
              ...["top", "left", "width"].map((side) => Math.abs(region[side] - before[side])),
            ),
          )
        : null,
    answer: answer ? inView(answer) : null,
  };
}
