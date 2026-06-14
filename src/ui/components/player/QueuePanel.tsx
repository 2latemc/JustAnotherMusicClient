import {  IconPlaylist, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { usePlayerSession, playerController } from "../../../player/playerStore";
import styles from "./QueuePanel.module.css";

interface QueuePanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function QueuePanel({ isOpen, onClose }: QueuePanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const draggedElementRef = useRef<HTMLElement | null>(null);
  const captureElementRef = useRef<HTMLElement | null>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    sourceIndex: number;
    section: "manual" | "automatic";
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    insertAfter: boolean;
  } | null>(null);
  const playerSession = usePlayerSession();
  const queue = playerSession?.queue ?? [];
  const queueIndex = playerSession?.queueIndex ?? -1;
  const manualQueueLength = playerSession?.manualQueueLength ?? 0;
  const upcomingStartIndex = Math.max(queueIndex + 1, 0);
  const upcoming = queue.slice(upcomingStartIndex);
  const manualQueue = upcoming.slice(0, manualQueueLength);
  const autoQueue = upcoming.slice(manualQueueLength);

  const handleRemove = (offset: number) => {
    playerController.removeFromQueueAt(upcomingStartIndex + offset);
  };

  const handlePlay = (offset: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    void playerController.playQueueTrackAt(upcomingStartIndex + offset);
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance < 6) return;
        drag.isDragging = true;
        setDraggedIndex(drag.sourceIndex);
      }

      event.preventDefault();
      const translationY = event.clientY - drag.startY;
      draggedElementRef.current?.style.setProperty(
        "--drag-translation",
        `${translationY}px`,
      );

      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>("[data-queue-index]") ?? [],
      ).filter((item) =>
        Number(item.dataset.queueIndex) !== drag.sourceIndex
        && item.dataset.queueSection === drag.section,
      );

      if (items.length === 0) {
        setDropTarget(null);
        return;
      }

      let targetElement = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-queue-index]"))
        .find((item) =>
          Boolean(item)
          && Number(item?.dataset.queueIndex) !== drag.sourceIndex
          && item?.dataset.queueSection === drag.section,
        ) ?? null;

      const panelBounds = panelRef.current?.getBoundingClientRect();
      if (panelBounds && event.clientY < panelBounds.top) {
        targetElement = items[0];
      } else if (panelBounds && event.clientY > panelBounds.bottom) {
        targetElement = items[items.length - 1];
      } else if (!targetElement) {
        targetElement = items.reduce<HTMLElement | null>((closest, item) => {
          if (!closest) return item;
          const itemCenter = item.getBoundingClientRect().top
            + item.getBoundingClientRect().height / 2;
          const closestCenter = closest.getBoundingClientRect().top
            + closest.getBoundingClientRect().height / 2;
          return Math.abs(itemCenter - event.clientY)
            < Math.abs(closestCenter - event.clientY)
            ? item
            : closest;
        }, null);
      }

      if (!targetElement) {
        setDropTarget(null);
        return;
      }

      const targetIndex = Number(targetElement.dataset.queueIndex);
      const bounds = targetElement.getBoundingClientRect();
      setDropTarget({
        index: targetIndex,
        insertAfter: event.clientY >= bounds.top + bounds.height / 2,
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (
        drag.isDragging
        && dropTarget
        && dropTarget.index !== drag.sourceIndex
      ) {
        playerController.moveQueueTrack(
          drag.sourceIndex,
          dropTarget.index,
          dropTarget.insertAfter,
        );
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }

      pointerDragRef.current = null;
      draggedElementRef.current?.style.removeProperty("--drag-translation");
      draggedElementRef.current?.style.removeProperty("will-change");
      captureElementRef.current?.releasePointerCapture?.(event.pointerId);
      draggedElementRef.current = null;
      captureElementRef.current = null;
      setDraggedIndex(null);
      setDropTarget(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dropTarget]);

  const handleTrackPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    absoluteIndex: number,
    section: "manual" | "automatic",
  ) => {
    if (event.button !== 0) return;
    const trackItem = event.currentTarget.closest<HTMLElement>("[data-queue-index]");
    if (!trackItem) return;

    pointerDragRef.current = {
      pointerId: event.pointerId,
      sourceIndex: absoluteIndex,
      section,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
    };
    draggedElementRef.current = trackItem;
    captureElementRef.current = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    trackItem.style.willChange = "transform";
  };

  const getTrackItemClassName = (absoluteIndex: number) => [
    styles.trackItem,
    draggedIndex !== null && styles.dragActive,
    draggedIndex === absoluteIndex && styles.dragging,
    dropTarget?.index === absoluteIndex
      && (dropTarget.insertAfter ? styles.dropAfter : styles.dropBefore),
  ].filter(Boolean).join(" ");

  return (
    <aside
      ref={panelRef}
      className={`${styles.queuePanel} ${isOpen ? styles.open : styles.closing}`}
      aria-label="Queue panel"
    >
      <div className={styles.header}>
        <h2 className={styles.title}>QUEUE</h2>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="Close queue panel"
        >
          <IconX size={18} />
        </button>
      </div>

      {upcoming.length === 0 ? (
        <p className={styles.emptyMessage}>No queued songs.</p>
      ) : (
        <>
          {manualQueue.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <IconPlaylist size={16} />
                <span>Manually added</span>
              </div>
              <div className={styles.trackList}>
                {manualQueue.map((track, index) => (
                  <div
                    key={`${track.id}:${upcomingStartIndex + index}`}
                    data-queue-index={upcomingStartIndex + index}
                    data-queue-section="manual"
                    className={getTrackItemClassName(upcomingStartIndex + index)}
                  >
                    <button
                      type="button"
                      className={styles.trackMain}
                      onPointerDown={(event) =>
                        handleTrackPointerDown(
                          event,
                          upcomingStartIndex + index,
                          "manual",
                        )
                      }
                      onClick={() => handlePlay(index)}
                    >
                      <span className={styles.trackIndex}>{index + 1}</span>
                      <span className={styles.trackDetails}>
                        <span className={styles.trackTitle}>{track.title}</span>
                        <span className={styles.trackArtist}>{track.artist}</span>
                      </span>
                     
                    </button>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => handleRemove(index)}
                      aria-label={`Remove ${track.title} from queue`}
                    >
                      <IconTrash size={16} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {autoQueue.length > 0 && (
            <div className={styles.section}>
              {manualQueue.length > 0 && (
                <div className={styles.sectionHeader}>
                  <IconPlaylist size={16} />
                  <span>Auto queue</span>
                </div>
              )}
              <div className={styles.trackList}>
                {autoQueue.map((track, index) => (
                  <div
                    key={`${track.id}:${upcomingStartIndex + manualQueueLength + index}`}
                    data-queue-index={upcomingStartIndex + manualQueueLength + index}
                    data-queue-section="automatic"
                    className={getTrackItemClassName(
                      upcomingStartIndex + manualQueueLength + index,
                    )}
                  >
                    <button
                      type="button"
                      className={styles.trackMain}
                      onPointerDown={(event) =>
                        handleTrackPointerDown(
                          event,
                          upcomingStartIndex + manualQueueLength + index,
                          "automatic",
                        )
                      }
                      onClick={() => handlePlay(manualQueueLength + index)}
                    >
                      <span className={styles.trackIndex}>
                        {manualQueueLength + index + 1}
                      </span>
                      <span className={styles.trackDetails}>
                        <span className={styles.trackTitle}>{track.title}</span>
                        <span className={styles.trackArtist}>{track.artist}</span>
                      </span>
                      
                    </button>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => handleRemove(manualQueueLength + index)}
                      aria-label={`Remove ${track.title} from queue`}
                    >
                      <IconTrash size={16} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
