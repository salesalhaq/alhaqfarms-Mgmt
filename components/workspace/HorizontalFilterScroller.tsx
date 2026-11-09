"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function HorizontalFilterScroller({
  className,
  ariaLabel,
  children,
}: {
  className: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setCanScrollLeft(viewport.scrollLeft > 1);
    setCanScrollRight(viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return undefined;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", updateScrollState);
    };
  }, [updateScrollState]);

  const scroll = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(180, viewport.clientWidth * 0.75),
      behavior: "smooth",
    });
  };

  return (
    <div className={`${className} horizontal-filter-scroller`} role="group" aria-label={ariaLabel}>
      <button
        className="horizontal-filter-arrow"
        type="button"
        aria-label={`Scroll ${ariaLabel.toLocaleLowerCase()} left`}
        title="Show filters to the left"
        disabled={!canScrollLeft}
        onClick={() => scroll(-1)}
      >
        <ChevronLeft size={17} />
      </button>
      <div className="horizontal-filter-viewport" ref={viewportRef}>
        <div className="horizontal-filter-content" ref={contentRef}>
          {children}
        </div>
      </div>
      <button
        className="horizontal-filter-arrow"
        type="button"
        aria-label={`Scroll ${ariaLabel.toLocaleLowerCase()} right`}
        title="Show filters to the right"
        disabled={!canScrollRight}
        onClick={() => scroll(1)}
      >
        <ChevronRight size={17} />
      </button>
    </div>
  );
}
