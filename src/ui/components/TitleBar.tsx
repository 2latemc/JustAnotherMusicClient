import { IconLayoutDashboard } from "@tabler/icons-react";
import { useMemo, useRef } from "react";
import styles from "./TitleBar.module.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { logInternalError, logInternalInfo, logInternalWarn } from "../../internal/logging";
import { MusicTabs } from "./MusicTabs";
import type { Tab } from "../types/tab";
import { isLinux } from "../platform";
import {
  useNativeWindowControls,
  useWindowsStyleWindowControls,
} from "../settings/windowControls";

interface TitleBarProps {
  tabs: Tab[];
  activeTabId: string;
  playingTabId: string | null;
  sidebarWidth: number;
  isHomeActive: boolean;
  onNavigateHome: () => void;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTab: (draggedTabId: string, targetTabId: string, insertAfter: boolean) => void;
  onboardingFirstTabId?: string;
}

export function TitleBar({
  tabs,
  activeTabId,
  playingTabId,
  sidebarWidth,
  isHomeActive,
  onNavigateHome,
  onCreateTab,
  onCloseTab,
  onSwitchTab,
  onReorderTab,
  onboardingFirstTabId,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const nativeWindowControls = useNativeWindowControls();
  const windowsStyleWindowControls = useWindowsStyleWindowControls();
  const homePointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressHomeClickRef = useRef(false);
  const hideHomeText = sidebarWidth <= 120;

  const homeButtonClasses = useMemo(() => [
    styles.homeButton,
    isHomeActive ? styles.homeButtonActive : "",
    isLinux ? styles.homeButtonLinux : "",
    hideHomeText ? styles.homeButtonIconOnly : "",
  ].filter(Boolean).join(" "), [isHomeActive, isLinux, hideHomeText]);

  const windowControlsClasses = [
    styles.windowControls,
    windowsStyleWindowControls ? styles.windowControlsWindows : "",
  ].filter(Boolean).join(" ");

  const startWindowDrag = async () => {
    try {
      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
      }

      await appWindow.startDragging();
    } catch (error) {
      logInternalError("TitleBar.startWindowDrag failed", error);
    }
  };

  const handleMinimize = async () => {
    try {
      if (await appWindow.isFullscreen()) {
        await appWindow.setFullscreen(false);
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      await appWindow.minimize();
    } catch (error) {
      logInternalError("TitleBar.minimize failed", error);
    }
  };

  const handleToggleFullscreen = async () => {
    try {
      await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    } catch (error) {
      logInternalError("TitleBar.fullscreen failed", error);
    }
  };

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={homeButtonClasses}
        style={{ width: `${sidebarWidth}px` }}
        onClick={() => {
          if (suppressHomeClickRef.current) {
            suppressHomeClickRef.current = false;
            return;
          }
          onNavigateHome();
        }}
        onPointerDown={(event) => {
          if (isLinux || event.button !== 0) return;
          suppressHomeClickRef.current = false;
          homePointerRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (isLinux) return;
          const pointer = homePointerRef.current;
          if (!pointer || pointer.pointerId !== event.pointerId) return;

          const distance = Math.hypot(
            event.clientX - pointer.startX,
            event.clientY - pointer.startY,
          );
          if (distance < 5) return;

          homePointerRef.current = null;
          suppressHomeClickRef.current = true;
          void startWindowDrag();
        }}
        onPointerUp={(event) => {
          if (homePointerRef.current?.pointerId === event.pointerId) {
            homePointerRef.current = null;
          }
        }}
        onPointerCancel={() => {
          homePointerRef.current = null;
        }}
        aria-label="Home"
        aria-current={isHomeActive ? "page" : undefined}
      >
        <IconLayoutDashboard size={18} aria-hidden="true" />
        {!hideHomeText && <span>Home</span>}
      </button>

      <MusicTabs
        tabs={tabs}
        activeTabId={activeTabId}
        playingTabId={playingTabId}
        onCreateTab={onCreateTab}
        onCloseTab={onCloseTab}
        onSwitchTab={onSwitchTab}
        onReorderTab={onReorderTab}
        onboardingFirstTabId={onboardingFirstTabId}
      />

      <div
        className={styles.dragArea}
        data-tauri-drag-region={isLinux ? "" : undefined}
        aria-label="Drag window"
        onPointerDown={(event) => {
          if (isLinux || event.button !== 0) return;
          void startWindowDrag();
        }}
      />

      {!nativeWindowControls && (
        <div className={windowControlsClasses} aria-label="Window controls">
          <button
            type="button"
            aria-label="Minimize"
            className={`${styles.windowButton} ${styles.windowButtonMinimize}`}
            onClick={() => void handleMinimize()}
          >
            <span aria-hidden="true" className={styles.windowIcon}>
              &#8211;
            </span>
          </button>
          <button
            type="button"
            aria-label="Fullscreen"
            className={`${styles.windowButton} ${styles.windowButtonMaximize}`}
            onClick={() => void handleToggleFullscreen()}
          >
            <span aria-hidden="true" className={styles.windowIcon}>
              □
            </span>
          </button>
          <button
            type="button"
            aria-label="Close"
            className={`${styles.windowButton} ${styles.windowButtonClose}`}
            onClick={() => {
              logInternalInfo("TitleBar.close clicked");
              void invoke("quit_app")
                .then(() => {
                  logInternalInfo("TitleBar.close quit_app invoked");
                })
                .catch((error) => {
                  logInternalError("TitleBar.close quit_app failed", error);
                  logInternalWarn("TitleBar.close fallback to appWindow.close");
                  void appWindow.close();
                });
            }}
          >
            <span aria-hidden="true" className={styles.windowIcon}>
              &#10005;
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
