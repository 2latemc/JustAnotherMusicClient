import { useEffect, useMemo, useState } from "react";
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
import { useLibraryState } from "../../player/playerStore";
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

export function PlaylistView({ playlist, playerController, libraryController }: PlaylistViewProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu } = usePlaylistContextMenu();
  const libraryState = useLibraryState();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<PlaylistSort>("dateAdded");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  useEffect(() => {
    if (!playlist) return;
    let active = true;
    const isLikedSongs = playlist.kind === "liked-songs" || playlist.id === "LM";
    setSort("dateAdded");
    setSortDirection("desc");
    const currentLibrary = libraryController.getState().library;
    if (isLikedSongs && currentLibrary) {
      setTracks(currentLibrary.likedSongs);
      setIsLoading(false);
      setError(null);
      return;
    }
    setTracks([]);
    setIsLoading(true);
    setError(null);
    void libraryController.getPlaylistTracks(playlist, (updatedTracks) => {
      if (active) setTracks(updatedTracks);
    })
      .then((items) => {
        if (active) setTracks(items);
      })
      .catch(() => {
        if (active) setError("Unable to load this playlist.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [playlist, libraryController]);

  useEffect(() => {
    if (playlist?.kind !== "liked-songs" && playlist?.id !== "LM") return;
    if (!libraryState.library) return;
    setTracks(libraryState.library.likedSongs);
    setIsLoading(false);
  }, [libraryState.library?.likedSongs, playlist?.id, playlist?.kind]);

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
      {!isLoading && !error && tracks.length === 0 && (
        <p className={styles.message}>This playlist is empty.</p>
      )}
      {!isLoading && !error && tracks.length > 0 && (
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
        </>
      )}
    </div>
  );
}
