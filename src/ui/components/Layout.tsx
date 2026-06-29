import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import styles from "./Layout.module.css";
import { SearchBar } from "./SearchBar";
import { Sidebar } from "./Sidebar";
import { StarField } from "./StarField";
import type { Album, Playlist } from "../../datasource/types";
import { usePaperPcMode } from "../settings/paperPcMode";

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

  return (
    <div className={styles.layout}>
      {!paperPcMode && <StarField />}
      
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
