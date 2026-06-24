import { ReactNode, useEffect, useRef, useState } from "react";
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
  rightPanel?: ReactNode;
  rightPanelWidth?: number;
  onRightPanelWidthChange?: (width: number) => void;
}

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
  rightPanel,
  rightPanelWidth = 340,
  onRightPanelWidthChange,
}: LayoutProps) {
  const paperPcMode = usePaperPcMode();
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | null>(null);
  const [isDraggingRightPanel, setIsDraggingRightPanel] = useState(false);

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

            <div
              className={`${styles.pageContent} ${fullBleedContent ? styles.fullBleedContent : ""}`}
              data-page-scroll-root
            >
              {children}
              
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
