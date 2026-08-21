import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Playlist, Track } from "../../datasource/types";
import { isLocalPlaylist, reorderLocalPlaylistTracks } from "../../player/localPlaylists";

interface UseLocalPlaylistDragReorderParams {
  playlist?: Playlist;
  sortedTracks: Track[];
  setTracks: Dispatch<SetStateAction<Track[]>>;
}

export function useLocalPlaylistDragReorder({
  playlist,
  sortedTracks,
  setTracks,
}: UseLocalPlaylistDragReorderParams) {
  const isLocalPlaylistView = playlist ? isLocalPlaylist(playlist) : false;
  const [dropTargetIndex, setDropTargetIndex] = useState<{ localPath: string; insertAfter: boolean } | null>(null);
  const sortedTracksRef = useRef(sortedTracks);
  sortedTracksRef.current = sortedTracks;
  const pointerDragRef = useRef<{
    pointerId: number;
    localPath: string;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const dropTargetRef = useRef<{ localPath: string; insertAfter: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (!isLocalPlaylistView) return;

    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (event.pointerId !== drag?.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.abs(event.clientY - drag.startY);
        if (distance < 6) return;
        drag.isDragging = true;
      }

      event.preventDefault();
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-playlist-track-path]");
      if (!target) {
        setDropTargetIndex(null);
        dropTargetRef.current = null;
        return;
      }

      const bounds = target.getBoundingClientRect();
      const nextTarget = {
        localPath: target.dataset.playlistTrackPath ?? "",
        insertAfter: event.clientY >= bounds.top + bounds.height / 2,
      };
      dropTargetRef.current = nextTarget;
      setDropTargetIndex(nextTarget);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (event.pointerId !== drag?.pointerId) return;

      if (drag.isDragging && dropTargetRef.current && playlist) {
        const fromPath = drag.localPath;
        const toPath = dropTargetRef.current.localPath;
        if (!fromPath || !toPath) {
          pointerDragRef.current = null;
          setDropTargetIndex(null);
          return;
        }

        const sorted = sortedTracksRef.current;
        const fromIndex = sorted.findIndex((t) => (t.localPath ?? t.id) === fromPath);
        const toIndex = sorted.findIndex((t) => (t.localPath ?? t.id) === toPath);
        if (fromIndex < 0 || toIndex < 0) return;

        const clampedToIndex = dropTargetRef.current.insertAfter
          ? Math.min(toIndex + 1, sorted.length)
          : toIndex;
        const insertIndex = fromIndex < clampedToIndex
          ? clampedToIndex - 1
          : clampedToIndex;

        if (fromIndex !== insertIndex) {
          reorderLocalPlaylistTracks(playlist.id, fromIndex, clampedToIndex);
          setTracks((current) => {
            const next = [...current];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(insertIndex, 0, moved);
            return next;
          });
        }
      }

      if (drag.isDragging) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      dropTargetRef.current = null;
      pointerDragRef.current = null;
      setDropTargetIndex(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isLocalPlaylistView, playlist, setTracks]);

  const handlePointerDown = (event: React.PointerEvent, track: Track) => {
    if (!isLocalPlaylistView || event.button !== 0) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      localPath: track.localPath ?? track.id,
      startY: event.clientY,
      isDragging: false,
    };
  };

  return {
    isLocalPlaylistView,
    dropTargetIndex,
    pointerDragRef,
    suppressClickRef,
    handlePointerDown,
  };
}
