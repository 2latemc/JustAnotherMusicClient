import { CSSProperties, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import styles from "./Layout.module.css";
import { SearchBar } from "./SearchBar";
import { Sidebar } from "./Sidebar";
import { StarField } from "./StarField";
import type { Album, Playlist } from "../../datasource/types";
import { usePaperPcMode } from "../settings/paperPcMode";
import { useAppTheme } from "../settings/themes";

interface LayoutProps {
  children: ReactNode;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  onNavigateAlbum: (album: Album) => void;
  onNavigatePlaylist: (playlist: Playlist) => void;
  onOpenSettings: () => void;
  showSearchBar: boolean;
  onOpenSearch: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  fullBleedContent?: boolean;
  showTransientScrollbar?: boolean;
  rightPanel?: ReactNode;
  rightPanelWidth?: number;
  onRightPanelWidthChange?: (width: number) => void;
}

const SCROLLBAR_HIDE_DELAY_MS = 760;
const MIN_SCROLLBAR_THUMB_HEIGHT = 34;
const MAX_SCROLLBAR_THUMB_HEIGHT = 86;
const MATRIX_RAIN_SEEDS = [
  "107K0M1Y3N0R1X04Z1A0T7L1",
  "01A9E01L7V20K1M50R3Y1N",
  "401N8T01R6Y03K10S7L1P",
  "130X17B0M41P09Q10V6K",
  "0M10Y51A0T8K107R2N1",
  "710S40N1E051810YK3A",
  "10P60A1R90M1510K3V7",
  "081V0K41Y0N7102X5R",
];
const MATRIX_RAIN_TRACK_COUNT = 78;
const MATRIX_RAIN_TRACKS = Array.from({ length: MATRIX_RAIN_TRACK_COUNT }, (_, index) => {
  const staggeredLeft = ((index * 37) % 100) + (index % 2 === 0 ? -0.2 : 0.4);
  return Math.max(0.5, Math.min(99.2, staggeredLeft));
});
const MATRIX_RAIN_COLUMNS = MATRIX_RAIN_TRACKS.map((left, index) => {
  const seed = MATRIX_RAIN_SEEDS[index % MATRIX_RAIN_SEEDS.length];
  const depth = index % 5 === 0 || index % 7 === 0 ? "far" : index % 3 === 0 ? "mid" : "near";
  const text = `${seed}${seed.slice(0, 10)}`
    .split("")
    .join("\n");

  return {
    depth,
    text,
    style: {
      "--theme-rain-left": `${left}vw`,
      "--theme-rain-size": `${depth === "far" ? 11 : depth === "mid" ? 13 : 15}px`,
      "--theme-rain-opacity": depth === "far" ? "0.16" : depth === "mid" ? "0.32" : "0.54",
      "--theme-rain-blur": depth === "far" ? "1.2px" : depth === "mid" ? "0.45px" : "0px",
      "--theme-rain-duration": `${depth === "far" ? 17 + (index % 6) : depth === "mid" ? 12 + (index % 5) : 8 + (index % 4)}s`,
      "--theme-rain-delay": `${-1 * ((index * 1.7) % 14)}s`,
    } as CSSProperties,
  };
});

export function Layout({ 
  children, 
  sidebarWidth,
  onSidebarWidthChange,
  onNavigateAlbum,
  onNavigatePlaylist,
  onOpenSettings,
  showSearchBar,
  onOpenSearch,
  canGoBack,
  canGoForward,
  onNavigateBack,
  onNavigateForward,
  fullBleedContent = false,
  showTransientScrollbar = false,
  rightPanel,
  rightPanelWidth = 340,
  onRightPanelWidthChange,
}: LayoutProps) {
  const paperPcMode = usePaperPcMode();
  const appTheme = useAppTheme();
  const pageContentRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | null>(null);
  const scrollHideTimerRef = useRef<number | null>(null);
  const scrollDragOffsetRef = useRef<number | null>(null);
  const isScrollbarHoveredRef = useRef(false);
  const isDraggingScrollbarRef = useRef(false);
  const [isDraggingRightPanel, setIsDraggingRightPanel] = useState(false);
  const [scrollbarState, setScrollbarState] = useState({
    isVisible: false,
    canScroll: false,
    thumbTop: 0,
    thumbHeight: 0,
  });
  const [isDraggingScrollbar, setIsDraggingScrollbar] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => document.visibilityState === "visible",
  );

  const clearScrollHideTimer = useCallback(() => {
    if (scrollHideTimerRef.current === null) return;
    window.clearTimeout(scrollHideTimerRef.current);
    scrollHideTimerRef.current = null;
  }, []);

  const updateScrollbarMetrics = useCallback((forceVisible = false) => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot) return;

    const { clientHeight, scrollHeight, scrollTop } = scrollRoot;
    const canScroll = scrollHeight > clientHeight + 1;
    if (!showTransientScrollbar || !canScroll) {
      setScrollbarState((current) => ({
        ...current,
        isVisible: false,
        canScroll,
        thumbTop: 0,
        thumbHeight: 0,
      }));
      return;
    }

    const thumbHeight = Math.min(
      MAX_SCROLLBAR_THUMB_HEIGHT,
      Math.max(
        MIN_SCROLLBAR_THUMB_HEIGHT,
        Math.round((clientHeight / scrollHeight) * clientHeight),
      ),
    );
    const travel = Math.max(1, clientHeight - thumbHeight);
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
    const thumbTop = Math.round((scrollTop / maxScrollTop) * travel);

    setScrollbarState({
      isVisible: forceVisible ? true : isScrollbarHoveredRef.current || isDraggingScrollbarRef.current,
      canScroll,
      thumbTop,
      thumbHeight,
    });
  }, [showTransientScrollbar]);

  const revealScrollbar = useCallback((persist = false) => {
    updateScrollbarMetrics(true);
    clearScrollHideTimer();
    if (persist) return;
    scrollHideTimerRef.current = window.setTimeout(() => {
      if (isScrollbarHoveredRef.current || isDraggingScrollbarRef.current) return;
      setScrollbarState((current) => ({ ...current, isVisible: false }));
    }, SCROLLBAR_HIDE_DELAY_MS);
  }, [clearScrollHideTimer, updateScrollbarMetrics]);

  const hideScrollbar = useCallback(() => {
    clearScrollHideTimer();
    setScrollbarState((current) => ({ ...current, isVisible: false }));
  }, [clearScrollHideTimer]);

  const scrollToThumbPosition = useCallback((clientY: number, pointerOffset: number) => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot || !scrollbarState.canScroll) return;

    const rect = scrollRoot.getBoundingClientRect();
    const travel = Math.max(1, rect.height - scrollbarState.thumbHeight);
    const thumbTop = Math.max(
      0,
      Math.min(travel, clientY - rect.top - pointerOffset),
    );
    const maxScrollTop = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTop = (thumbTop / travel) * maxScrollTop;
  }, [scrollbarState.canScroll, scrollbarState.thumbHeight]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (
        dragStartX.current === null
        || !rightPanelRef.current
        || !onRightPanelWidthChange
      ) return;

      if (Math.abs(event.clientX - dragStartX.current) < 4) return;
      const rect = rightPanelRef.current.getBoundingClientRect();
      const availableWidth = Math.max(280, window.innerWidth - sidebarWidth - 240);
      const nextWidth = rect.right - event.clientX;
      onRightPanelWidthChange(Math.max(280, Math.min(520, availableWidth, nextWidth)));
    };

    const handleMouseUp = () => {
      dragStartX.current = null;
      setIsDraggingRightPanel(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onRightPanelWidthChange, sidebarWidth]);

  useEffect(() => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot || !showTransientScrollbar) {
      setScrollbarState((current) => ({ ...current, isVisible: false, canScroll: false }));
      return;
    }

    const handleScroll = () => revealScrollbar();
    const handleResize = () => updateScrollbarMetrics(
      isScrollbarHoveredRef.current || isDraggingScrollbarRef.current,
    );

    updateScrollbarMetrics(false);
    scrollRoot.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    return () => {
      scrollRoot.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, [
    revealScrollbar,
    showTransientScrollbar,
    updateScrollbarMetrics,
  ]);

  useEffect(() => () => clearScrollHideTimer(), [clearScrollHideTimer]);

  useEffect(() => {
    const updateVisibility = () => {
      setIsDocumentVisible(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  return (
    <div className={styles.layout} data-theme-root>
      <div className={styles.themeBackdrop} data-theme-backdrop aria-hidden="true">
        {appTheme === "matrix" && isDocumentVisible
          ? MATRIX_RAIN_COLUMNS.map((column, index) => (
            <span
              key={`${index}-${column.text}`}
              className={styles.themeRainColumn}
              data-theme-rain-depth={column.depth}
              data-theme-rain-column
              style={column.style}
            >
              {column.text}
            </span>
          ))
          : null}
      </div>
      {!paperPcMode && isDocumentVisible && <StarField />}
      
      <div className={styles.mainContent}>
        <Sidebar
          width={sidebarWidth}
          onWidthChange={onSidebarWidthChange}
          onNavigateAlbum={onNavigateAlbum}
          onNavigatePlaylist={onNavigatePlaylist}
        />
        <div className={styles.contentArea}>
          {showSearchBar && (
            <SearchBar
              onOpen={onOpenSearch}
              onOpenSettings={onOpenSettings}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onBack={onNavigateBack}
              onForward={onNavigateForward}
            />
          )}
           
          <div className={styles.contentContainer}>

            <div className={styles.pageScrollShell}>
              <div
                ref={pageContentRef}
                className={`${styles.pageContent} ${fullBleedContent ? styles.fullBleedContent : ""}`}
                data-page-scroll-root
              >
                {children}
              </div>
              {showTransientScrollbar && scrollbarState.canScroll && (
                <div
                  className={`${styles.transientScrollbarHitArea} ${
                    scrollbarState.isVisible ? styles.transientScrollbarVisible : ""
                  }`}
                  onPointerEnter={() => {
                    isScrollbarHoveredRef.current = true;
                    revealScrollbar(true);
                  }}
                  onPointerLeave={() => {
                    isScrollbarHoveredRef.current = false;
                    if (!isDraggingScrollbarRef.current) hideScrollbar();
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    const target = event.target;
                    const thumb = event.currentTarget.querySelector("[data-scrollbar-thumb]");
                    const thumbRect = thumb instanceof HTMLElement
                      ? thumb.getBoundingClientRect()
                      : null;
                    const offset = target === thumb && thumbRect
                      ? event.clientY - thumbRect.top
                      : scrollbarState.thumbHeight / 2;

                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    scrollDragOffsetRef.current = offset;
                    isDraggingScrollbarRef.current = true;
                    setIsDraggingScrollbar(true);
                    revealScrollbar(true);
                    scrollToThumbPosition(event.clientY, offset);
                  }}
                  onPointerMove={(event) => {
                    if (!isDraggingScrollbar || scrollDragOffsetRef.current === null) return;
                    scrollToThumbPosition(event.clientY, scrollDragOffsetRef.current);
                  }}
                  onPointerUp={(event) => {
                    scrollDragOffsetRef.current = null;
                    isDraggingScrollbarRef.current = false;
                    setIsDraggingScrollbar(false);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    if (isScrollbarHoveredRef.current) {
                      revealScrollbar(true);
                    } else {
                      hideScrollbar();
                    }
                  }}
                  onPointerCancel={(event) => {
                    scrollDragOffsetRef.current = null;
                    isDraggingScrollbarRef.current = false;
                    setIsDraggingScrollbar(false);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    hideScrollbar();
                  }}
                  aria-hidden="true"
                >
                  <div className={styles.transientScrollbarTrack}>
                    <div
                      className={`${styles.transientScrollbarThumb} ${
                        isDraggingScrollbar ? styles.transientScrollbarThumbActive : ""
                      }`}
                      data-scrollbar-thumb
                      style={{
                        height: `${scrollbarState.thumbHeight}px`,
                        transform: `translateY(${scrollbarState.thumbTop}px)`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
            {rightPanel && (
              <div
                ref={rightPanelRef}
                className={styles.rightPanel}
                style={{ width: `${rightPanelWidth}px` }}
              >
                <div
                  className={`${styles.rightPanelDragHandle} ${
                    isDraggingRightPanel ? styles.rightPanelDragHandleActive : ""
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dragStartX.current = event.clientX;
                    setIsDraggingRightPanel(true);
                  }}
                  title="Drag to resize queue"
                />
                {rightPanel}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
