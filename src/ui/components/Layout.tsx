import { ReactNode } from "react";
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
  fullBleedContent?: boolean;
  rightPanel?: ReactNode;
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
  fullBleedContent = false,
  rightPanel,
}: LayoutProps) {
  const paperPcMode = usePaperPcMode();

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
            <SearchBar onOpen={onOpenSearch} onOpenSettings={onOpenSettings} />
          )}
          <div className={styles.contentContainer}>
            <div className={`${styles.pageContent} ${fullBleedContent ? styles.fullBleedContent : ""}`}>
              {children}
            </div>
            {rightPanel && (
              <div className={styles.rightPanel}>
                {rightPanel}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
