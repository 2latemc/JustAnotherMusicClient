import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsShuffle,
  IconHeart,
  IconPlayerPlay,
} from "@tabler/icons-react";
import type { Playlist, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { markPlaylistPlayed } from "../../player/recentPlaylists";
import { shuffleTracks } from "../../player/shuffleTracks";
import { useTrackContextMenu } from "../components/TrackContextMenu";
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

function appendUniqueTracks(current: Track[], next: Track[]): Track[] {
  if (next.length === 0) return current;
  const existingIds = new Set(current.map((track) => track.id));
  const uniqueNext = next.filter((track) => {
    if (existingIds.has(track.id)) return false;
    existingIds.add(track.id);
    return true;
  });
  return uniqueNext.length > 0 ? [...current, ...uniqueNext] : current;
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
  const [sort, setSort] = useState<PlaylistSort>("dateAdded");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const playlistIdRef = useRef<string | undefined>(undefined);
  const isLoadingMoreRef = useRef(false);

  playlistIdRef.current = playlist?.id;
  isLoadingMoreRef.current = isLoadingMore;

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
    let showedPage = false;
    const showPage = (page: { tracks: Track[]; hasMore: boolean; nextPageKey?: string }) => {
      if (!active) return;
      showedPage = true;
      setTracks(page.tracks);
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
      setTracks((current) => appendUniqueTracks(current, page.tracks));
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
      {isLoading && <p className={styles.message}>Loading songs...</p>}
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
            {sortedTracks.map((track, index) => (
              <button
                key={track.playlistItemId ?? `${track.id}:${index}`}
                className={styles.track}
                onContextMenu={(event) => openTrackMenu(event, track, {
                  playlist,
                  onRemove: removeTrackFromList,
                })}
                onClick={() => void playPlaylistTrack(track)}
              >
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
            ))}
          </div>
          <div ref={loadMoreRef} className={styles.loadMoreStatus} aria-live="polite">
            {isLoadingMore
              ? "Loading more songs..."
              : loadMoreError
                ? loadMoreError
                : hasMoreTracks
                  ? ""
                  : ""}
          </div>
        </>
      )}
    </div>
  );
}
