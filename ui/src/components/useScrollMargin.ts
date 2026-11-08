import { useEffect, useState } from "react";

/** The toolbar and banners change the table body's offset within the scrolling content. */
export function useScrollMargin(scroller: HTMLElement | null, body: HTMLElement | null) {
  const [margin, setMargin] = useState(0);
  useEffect(() => {
    if (!scroller || !body) return;
    const measure = () => {
      const top =
        body.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setMargin((m) => (Math.abs(top - m) > 0.5 ? top : m));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [scroller, body]);
  return margin;
}

export function scrollParent(el: HTMLElement | null) {
  for (let p = el?.parentElement; p; p = p.parentElement)
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}
