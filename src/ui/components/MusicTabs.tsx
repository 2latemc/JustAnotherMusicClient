import { useEffect, useRef, useState } from "react";
import { IconX, IconPlus, IconVolume } from "@tabler/icons-react";
import styles from "./MusicTabs.module.css";
import { Tab } from "../types/tab";
import { isLinux } from "../platform";

const MAX_TAB_TITLE_LENGTH = 32;

function getTabTitle(tab: Tab): string {
  if (tab.view === "settings") return "Settings";
  if (tab.view === "search" && tab.searchQuery) return tab.searchQuery;
  if (!tab.title) return "New Tab";
  if (tab.title.length <= MAX_TAB_TITLE_LENGTH) return tab.title;
  return `${tab.title.slice(0, MAX_TAB_TITLE_LENGTH - 3)}...`;
}

interface MusicTabsProps {
  tabs: Tab[];
  activeTabId: string;
  playingTabId: string | null;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTab: (draggedTabId: string, targetTabId: string, insertAfter: boolean) => void;
  onboardingFirstTabId?: string;
}

export function MusicTabs({
  tabs,
  activeTabId,
  playingTabId,
  onCreateTab,
  onCloseTab,
  onSwitchTab,
  onReorderTab,
  onboardingFirstTabId,
}: MusicTabsProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    tabId: string;
    insertAfter: boolean;
  } | null>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    tabId: string;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const dropTargetRef = useRef(dropTarget);
  const suppressClickRef = useRef(false);

  const clearDragState = () => {
    pointerDragRef.current = null;
    setDraggedTabId(null);
    setDropTarget(null);
  };

  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance < 5) return;
        drag.isDragging = true;
        setDraggedTabId(drag.tabId);
      }

      event.preventDefault();
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-music-tab-id]");
      const targetTabId = target?.dataset.musicTabId;
      if (!target || !targetTabId || targetTabId === drag.tabId) {
        dropTargetRef.current = null;
        setDropTarget(null);
        return;
      }

      const bounds = target.getBoundingClientRect();
      const nextDropTarget = {
        tabId: targetTabId,
        insertAfter: event.clientX >= bounds.left + bounds.width / 2,
      };
      dropTargetRef.current = nextDropTarget;
      setDropTarget(nextDropTarget);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (drag.isDragging) {
        const target = dropTargetRef.current;
        if (target) {
          onReorderTab(drag.tabId, target.tabId, target.insertAfter);
        }
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      clearDragState();
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [onReorderTab]);

  const canCloseTabs = tabs.length > 1;

  return (
    <div className={styles.tabsContainer}>
      <div
        className={`${styles.tabsList} ${isLinux ? styles.tabsListLinux : ""}`}
        data-tauri-drag-region={isLinux ? undefined : ""}
      >
        {tabs.map((tab) => {
          const title = getTabTitle(tab);
          return (
            <div
              key={tab.id}
              className={[
                styles.tab,
                activeTabId === tab.id ? styles.active : "",
                draggedTabId === tab.id ? styles.dragging : "",
                dropTarget?.tabId === tab.id && !dropTarget.insertAfter
                  ? styles.dropBefore
                  : "",
                dropTarget?.tabId === tab.id && dropTarget.insertAfter
                  ? styles.dropAfter
                  : "",
              ].filter(Boolean).join(" ")}
              data-music-tab-id={tab.id}
              data-onboarding={tab.id === onboardingFirstTabId ? "first-tab" : undefined}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onSwitchTab(tab.id);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if ((event.target as Element).closest("button")) return;
                pointerDragRef.current = {
                  pointerId: event.pointerId,
                  tabId: tab.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  isDragging: false,
                };
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSwitchTab(tab.id);
                }
              }}
            >
              <div className={styles.tabContent}>
                {playingTabId === tab.id && (
                  <IconVolume
                    className={styles.playingIcon}
                    size={15}
                    aria-label="Currently playing"
                  />
                )}
                <span className={styles.tabSong} title={tab.title}>
                  {title}
                </span>
              </div>
              {canCloseTabs && (
                <button
                  className={styles.closeButton}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  aria-label={`Close ${title}`}
                >
                  <IconX size={18} />
                </button>
              )}
            </div>
          );
        })}
        <button
          className={styles.addTabButton}
          type="button"
          onClick={onCreateTab}
          aria-label="Add new tab"
          data-onboarding="new-tab"
        >
          <IconPlus size={18} />
        </button>
      </div>
    </div>
  );
}
