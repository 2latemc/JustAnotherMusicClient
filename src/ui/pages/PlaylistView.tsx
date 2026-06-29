import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsShuffle,
  IconHeart,
  IconLoader2,
  IconPlayerPlay,
} from "@tabler/icons-react";
import type { Playlist, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { markPlaylistPlayed } from "../../player/recentPlaylists";
import { shuffleTracks } from "../../player/shuffleTracks";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { isLocalPlaylist, reorderLocalPlaylistTracks } from "../../player/localPlaylists";
import styles from "./AlbumView.module.css";
import { ArtistLinks } from "../components/ArtistLinks";
import { usePlaylistContextMenu } from "../components/PlaylistContextMenu";
import { TrackArtwork } from "../components/TrackArtwork";

interface PlaylistViewProps {
  playlist?: Playlist;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
}

type PlaylistSort = "dateAdded" | "name" | "album";
type SortDirection = "asc" | "desc";

const playlistSorts: Array<{ value: PlaylistSort; label: string }> = [
  { value: "name", label: "Name" },
  { value: "album", label: "Album" },
  { value: "dateAdded", label: "Date Added" },
];

function compareText(left: string | undefined, right: string | undefined): number {
  return (left || "\uffff").localeCompare(right || "\uffff", undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function getDirectionLabel(sort: PlaylistSort, direction: SortDirection): string {
  if (sort === "dateAdded") return direction === "desc" ? "Newest" : "Oldest";
  return direction === "asc" ? "Asc" : "Desc";
}

function SortDirectionIcon({ direction }: { direction: SortDirection }) {
  return direction === "asc"
    ? <IconArrowUp size={13} stroke={2.2} aria-hidden="true" />
    : <IconArrowDown size={13} stroke={2.2} aria-hidden="true" />;
}

function getTrackKey(track: Track): string {
  return track.playlistItemId ?? track.id;
}

function getTrackRenderKey(track: Track, index: number): string {
  return track.playlistItemId ?? `${track.id}:${index}`;
}

function getUniqueNewTracks(current: Track[], next: Track[]): Track[] {
  const existingIds = new Set(current.map((track) => track.id));
  return next.filter((track) => {
    if (existingIds.has(track.id)) return false;
    existingIds.add(track.id);
    return true;
  });
}

function PlaylistLoadingSpinner({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite" aria-label={label}>
      <IconLoader2 className={styles.loadingIcon} size={30} aria-hidden="true" />
    </div>
  );
}

export function PlaylistView({ playlist, playerController, libraryController }: PlaylistViewProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu } = usePlaylistContextMenu();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreTracks, setHasMoreTracks] = useState(false);
  const [nextPageKey, setNextPageKey] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [enteringTrackKeys, setEnteringTrackKeys] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<PlaylistSort>("dateAdded");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [dropTargetIndex, setDropTargetIndex] = useState<{ localPath: string; insertAfter: boolean } | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const playlistIdRef = useRef<string | undefined>(undefined);
  const isLoadingMoreRef = useRef(false);
  const tracksRef = useRef<Track[]>([]);
  const pointerDragRef = useRef<{
    pointerId: number;
    localPath: string;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const dropTargetRef = useRef<{ localPath: string; insertAfter: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  playlistIdRef.current = playlist?.id;
  isLoadingMoreRef.current = isLoadingMore;
  tracksRef.current = tracks;

  const isLocalPlaylistView = playlist ? isLocalPlaylist(playlist) : false;

  useEffect(() => {
    if (!playlist) return;
    let active = true;
    setSort("dateAdded");
    setSortDirection("desc");
    setTracks([]);
    setIsLoading(true);
    setIsLoadingMore(false);
    setHasMoreTracks(false);
    setNextPageKey(undefined);
    setError(null);
    setLoadMoreError(null);
    setEnteringTrackKeys(new Set());
    let showedPage = false;
    const showPage = (page: { tracks: Track[]; hasMore: boolean; nextPageKey?: string }) => {
      if (!active) return;
      showedPage = true;
      setTracks(page.tracks);
      setEnteringTrackKeys(new Set(page.tracks.map(getTrackKey)));
      setHasMoreTracks(page.hasMore);
      setNextPageKey(page.nextPageKey);
      setIsLoading(false);
    };
    void libraryController.getPlaylistTrackPage(playlist, undefined, (page) => {
      if (page.tracks.length > 0) showPage(page);
    })
      .then((page) => {
        showPage(page);
      })
      .catch(() => {
        if (active && !showedPage) setError("Unable to load this playlist.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [playlist, libraryController]);

  const loadMoreTracks = useCallback(async () => {
    if (!playlist || !hasMoreTracks || !nextPageKey || isLoading || isLoadingMoreRef.current) return;
    const loadingPlaylistId = playlist.id;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const page = await libraryController.getPlaylistTrackPage(playlist, nextPageKey);
      if (playlistIdRef.current !== loadingPlaylistId) return;
      const uniqueNewTracks = getUniqueNewTracks(tracksRef.current, page.tracks);
      setEnteringTrackKeys(new Set(uniqueNewTracks.map(getTrackKey)));
      if (uniqueNewTracks.length > 0) {
        setTracks((current) => [...current, ...uniqueNewTracks]);
      }
      setHasMoreTracks(page.hasMore);
      setNextPageKey(page.nextPageKey);
    } catch {
      if (playlistIdRef.current === loadingPlaylistId) {
        setLoadMoreError("Could not load more songs.");
      }
    } finally {
      if (playlistIdRef.current === loadingPlaylistId) {
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [hasMoreTracks, isLoading, libraryController, nextPageKey, playlist]);

  useEffect(() => {
    if (!hasMoreTracks) return;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const scrollRoot = sentinel.closest("[data-page-scroll-root]");

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMoreTracks();
      }
    }, {
      root: scrollRoot instanceof Element ? scrollRoot : null,
      rootMargin: "700px 0px",
    });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreTracks, loadMoreTracks, tracks.length]);

  const sortedTracks = useMemo(() => {
    if (sort === "dateAdded") {
      return sortDirection === "desc" ? tracks : [...tracks].reverse();
    }
    const sorted = [...tracks].sort((left, right) => {
      if (sort === "name") {
        return compareText(left.title, right.title)
          || compareText(left.artist, right.artist)
          || compareText(left.album, right.album);
      }
      return compareText(left.album, right.album)
        || compareText(left.title, right.title)
        || compareText(left.artist, right.artist);
    });
    return sortDirection === "asc" ? sorted : sorted.reverse();
  }, [sort, sortDirection, tracks]);

  const sortedTracksRef = useRef(sortedTracks);
  sortedTracksRef.current = sortedTracks;

  const enteringTrackDelayIndexes = useMemo(() => {
    const delayIndexes = new Map<string, number>();
    sortedTracks.forEach((track) => {
      const key = getTrackKey(track);
      if (enteringTrackKeys.has(key)) {
        delayIndexes.set(key, delayIndexes.size);
      }
    });
    return delayIndexes;
  }, [enteringTrackKeys, sortedTracks]);

  // Drag to reorder for local playlists
  useEffect(() => {
    if (!isLocalPlaylistView) return;

    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

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
      if (!drag || event.pointerId !== drag.pointerId) return;

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

        if (fromIndex !== clampedToIndex) {
          reorderLocalPlaylistTracks(playlist.id, fromIndex, clampedToIndex);
          setTracks((current) => {
            const next = [...current];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(clampedToIndex, 0, moved);
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
  }, [isLocalPlaylistView, playlist]);

  if (!playlist) return null;

  const playPlaylistTrack = async (track: Track) => {
    const started = await playerController.playTrackById(track.id, sortedTracks);
    if (started) markPlaylistPlayed(playlist.id);
  };

  const playShuffled = async () => {
    const shuffledTracks = shuffleTracks(tracks);
    const firstTrack = shuffledTracks[0];
    if (!firstTrack) return;

    const started = await playerController.playTrackById(firstTrack.id, shuffledTracks);
    if (started) markPlaylistPlayed(playlist.id);
  };

  const removeTrackFromList = (removedTrack: Track) => {
    setTracks((current) => current.filter((item) =>
      playlist.kind === "liked-songs" || playlist.id === "LM"
        ? item.id !== removedTrack.id
        : removedTrack.localPath
          ? item.localPath !== removedTrack.localPath
          : item.playlistItemId !== removedTrack.playlistItemId
    ));
  };

  const selectSort = (nextSort: PlaylistSort) => {
    if (nextSort === sort) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSort(nextSort);
    setSortDirection(nextSort === "dateAdded" ? "desc" : "asc");
  };

  const handlePointerDown = (event: React.PointerEvent, track: Track) => {
    if (!isLocalPlaylistView || event.button !== 0) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      localPath: track.localPath ?? track.id,
      startY: event.clientY,
      isDragging: false,
    };
  };

  return (
    <div className={styles.root}>
      <header
        className={styles.header}
        onContextMenu={(event) => openPlaylistMenu(event, playlist)}
      >
        {playlist.kind === "liked-songs" || playlist.id === "LM" ? (
          <div className={`${styles.cover} ${styles.coverFrame}`}>
            <IconHeart size={80} stroke={1.6} aria-hidden="true" />
          </div>
        ) : (
          <TrackArtwork
            className={`${styles.cover} ${styles.coverFrame}`}
            artworkUrl={playlist.artworkUrl}
            iconSize={80}
            loading="eager"
            variant="playlist"
          />
        )}
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>Playlist</span>
          <h1 className={styles.title}>{playlist.title}</h1>
          <p className={styles.artist}>{playlist.owner}</p>
        </div>
        <button
          className={styles.shuffleButton}
          type="button"
          disabled={isLoading || Boolean(error) || tracks.length === 0}
          onClick={() => void playShuffled()}
        >
          <IconArrowsShuffle size={18} aria-hidden="true" />
          <span>Shuffle</span>
        </button>
      </header>
      {isLoading && <PlaylistLoadingSpinner label="Loading songs" />}
      {error && <p className={styles.message}>{error}</p>}
      {!isLoading && !error && !hasMoreTracks && tracks.length === 0 && (
        <p className={styles.message}>This playlist is empty.</p>
      )}
      {!isLoading && !error && (tracks.length > 0 || hasMoreTracks) && (
        <>
          <div
            className={styles.sortOptions}
            role="group"
            aria-label="Playlist song sorting"
          >
            {playlistSorts.map((item) => (
              <button
                key={item.value}
                type="button"
                className={sort === item.value ? styles.activeSortOption : ""}
                aria-pressed={sort === item.value}
                aria-label={`Sort by ${item.label} ${
                  sort === item.value ? getDirectionLabel(item.value, sortDirection) : ""
                }`.trim()}
                onClick={() => selectSort(item.value)}
              >
                <span>{item.label}</span>
                {sort === item.value && (
                  <span
                    className={`${styles.sortDirection} ${
                      item.value === "dateAdded" ? styles.dateSortDirection : ""
                    }`}
                    aria-hidden="true"
                  >
                    <span className={styles.sortArrow}>
                      <SortDirectionIcon direction={sortDirection} />
                    </span>
                    {item.value === "dateAdded" && (
                      <span className={styles.sortHoverLabel}>
                        {getDirectionLabel(item.value, sortDirection)}
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className={styles.trackList}>
            {sortedTracks.map((track, index) => {
              const trackKey = getTrackKey(track);
              const trackPath = track.localPath ?? track.id;
              const isDragged = pointerDragRef.current?.localPath === trackPath && pointerDragRef.current.isDragging;
              const isDropBefore = dropTargetIndex
                && dropTargetIndex.localPath === trackPath
                && !dropTargetIndex.insertAfter;
              const isDropAfter = dropTargetIndex
                && dropTargetIndex.localPath === trackPath
                && dropTargetIndex.insertAfter;
              return (
                <button
                  key={getTrackRenderKey(track, index)}
                  data-playlist-track-path={trackPath}
                  className={`${styles.track} ${
                    enteringTrackDelayIndexes.has(trackKey) ? styles.trackEntering : ""
                  }`}
                  style={{
                    "--track-enter-delay": `${Math.min(
                      enteringTrackDelayIndexes.get(trackKey) ?? 0,
                      18,
                    ) * 28}ms`,
                    opacity: isDragged ? 0.4 : undefined,
                    position: "relative" as const,
                  } as CSSProperties}
                  onContextMenu={(event) => openTrackMenu(event, track, {
                    playlist,
                    onRemove: removeTrackFromList,
                  })}
                  onPointerDown={(event) => handlePointerDown(event, track)}
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    void playPlaylistTrack(track);
                  }}
                >
                  {isDropBefore && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        height: "2px",
                        background: "var(--color-accent)",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  {isDropAfter && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: -1,
                        left: 0,
                        right: 0,
                        height: "2px",
                        background: "var(--color-accent)",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  <span className={styles.trackIndex}>{index + 1}</span>
                  <span className={styles.trackText}>
                    <span className={styles.trackTitle}>{track.title}</span>
                    <ArtistLinks
                      className={styles.trackArtist}
                      artists={track.artists}
                      fallback={track.artist}
                    />
                  </span>
                  <IconPlayerPlay size={18} />
                </button>
              );
            })}
          </div>
          <div ref={loadMoreRef} className={styles.loadMoreStatus} aria-live="polite">
            {isLoadingMore ? (
              <PlaylistLoadingSpinner label="Loading more songs" />
            ) : loadMoreError ? (
              loadMoreError
            ) : hasMoreTracks ? (
              ""
            ) : (
              ""
            )}
          </div>
        </>
      )}
    </div>
  );
}