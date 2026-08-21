import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { IconArrowsShuffle, IconLoader2, IconPlayerPlay, IconSearch, IconX } from "@tabler/icons-react";
import type { Album, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { shuffleTracks } from "../../player/shuffleTracks";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { ArtistLinks } from "../components/ArtistLinks";
import { TrackArtwork } from "../components/TrackArtwork";
import styles from "./AlbumView.module.css";
import { useKeyboardShortcuts } from "../settings/keyboardShortcuts";
import { shouldStartPageSearch } from "./pageSearchKeyboard";

interface AlbumViewProps {
  album?: Album;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
}

function getTrackKey(track: Track): string {
  return track.playlistItemId ?? track.id;
}

function getTrackRenderKey(track: Track, index: number): string {
  return track.playlistItemId ?? `${track.id}:${index}`;
}

function AlbumLoadingSpinner({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite" aria-label={label}>
      <IconLoader2 className={styles.loadingIcon} size={30} aria-hidden="true" />
    </div>
  );
}

export function AlbumView({ album, playerController, libraryController }: AlbumViewProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const keyboardShortcuts = useKeyboardShortcuts();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [albumSearchQuery, setAlbumSearchQuery] = useState("");
  const [enteringTrackKeys, setEnteringTrackKeys] = useState<Set<string>>(new Set());
  const albumSearchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!album) return;
    let active = true;
    setTracks([]);
    setAlbumSearchQuery("");
    setIsLoading(true);
    setError(null);
    setEnteringTrackKeys(new Set());
    let showedTracks = false;
    void libraryController.getAlbumTracks(album, (updatedTracks) => {
      if (!active) return;
      showedTracks = updatedTracks.length > 0;
      setTracks(updatedTracks);
      setEnteringTrackKeys(new Set(updatedTracks.map(getTrackKey)));
      if (updatedTracks.length > 0) setIsLoading(false);
    })
      .then((items) => {
        if (!active) return;
        showedTracks = true;
        setTracks(items);
        setEnteringTrackKeys(new Set(items.map(getTrackKey)));
      })
      .catch(() => {
        if (active && !showedTracks) setError("Unable to load this album.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [album, libraryController]);

  const visibleTracks = useMemo(() => {
    const query = albumSearchQuery.trim().toLocaleLowerCase();
    if (!query) return tracks;
    return tracks.filter((track) => [
      track.title,
      track.artist,
      track.album,
      ...(track.artists?.map((artist) => artist.name) ?? []),
    ].some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [albumSearchQuery, tracks]);

  const enteringTrackDelayIndexes = useMemo(() => {
    const delayIndexes = new Map<string, number>();
    visibleTracks.forEach((track) => {
      const key = getTrackKey(track);
      if (enteringTrackKeys.has(key)) {
        delayIndexes.set(key, delayIndexes.size);
      }
    });
    return delayIndexes;
  }, [enteringTrackKeys, visibleTracks]);

  useEffect(() => {
    if (!album || isLoading || error || tracks.length === 0) return;

    const handlePageSearchKeyDown = (event: KeyboardEvent) => {
      if (!shouldStartPageSearch(event, keyboardShortcuts)) return;
      event.preventDefault();
      setAlbumSearchQuery((current) => `${current}${event.key}`);
      window.requestAnimationFrame(() => albumSearchInputRef.current?.focus());
    };

    window.addEventListener("keydown", handlePageSearchKeyDown);
    return () => window.removeEventListener("keydown", handlePageSearchKeyDown);
  }, [album, error, isLoading, keyboardShortcuts, tracks.length]);

  if (!album) return null;

  const playShuffled = () => {
    const shuffledTracks = shuffleTracks(tracks);
    const firstTrack = shuffledTracks[0];
    if (firstTrack) void playerController.playTrackById(firstTrack.id, shuffledTracks);
  };

  const handleAlbumSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Backspace" || albumSearchQuery) return;
    event.preventDefault();
    event.currentTarget.blur();
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <TrackArtwork
          className={styles.cover}
          artworkUrl={album.artworkUrl}
          iconSize={80}
          loading="eager"
          variant="album"
        />
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>Album</span>
          <h1 className={styles.title}>{album.title}</h1>
          <p className={styles.artist}>
            <ArtistLinks artists={album.artists} fallback={album.artist} />
          </p>
        </div>
        <button
          className={styles.shuffleButton}
          type="button"
          disabled={isLoading || Boolean(error) || tracks.length === 0}
          onClick={playShuffled}
        >
          <IconArrowsShuffle size={18} aria-hidden="true" />
          <span>Shuffle</span>
        </button>
      </header>
      {isLoading && <AlbumLoadingSpinner label="Loading songs" />}
      {error && <p className={styles.message}>{error}</p>}
      {!isLoading && !error && tracks.length > 0 && (
        <>
          <div
            className={styles.sortOptions}
            role="group"
            aria-label="Album song tools"
          >
            <div
              className={`${styles.playlistSearch} ${
                albumSearchQuery ? styles.playlistSearchActive : ""
              }`}
              role="search"
              onClick={() => albumSearchInputRef.current?.focus()}
            >
              <span className={styles.playlistSearchIcon}>
                <IconSearch size={16} aria-hidden="true" />
              </span>
              <input
                ref={albumSearchInputRef}
                type="text"
                value={albumSearchQuery}
                aria-label="Search songs in album"
                placeholder="Search album"
                onChange={(event) => setAlbumSearchQuery(event.target.value)}
                onKeyDown={handleAlbumSearchKeyDown}
              />
              {albumSearchQuery && (
                <button
                  className={styles.playlistSearchClear}
                  type="button"
                  aria-label="Clear album search"
                  onClick={() => setAlbumSearchQuery("")}
                >
                  <IconX size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {visibleTracks.length === 0 && albumSearchQuery.trim() ? (
            <p className={styles.message}>No songs match this search.</p>
          ) : (
            <div className={styles.trackList}>
              {visibleTracks.map((track, index) => {
                const trackKey = getTrackKey(track);
                return (
                  <button
                    key={getTrackRenderKey(track, index)}
                    className={`${styles.track} ${
                      enteringTrackDelayIndexes.has(trackKey) ? styles.trackEntering : ""
                    }`}
                    style={{
                      "--track-enter-delay": `${Math.min(
                        enteringTrackDelayIndexes.get(trackKey) ?? 0,
                        18,
                      ) * 28}ms`,
                    } as CSSProperties}
                    onContextMenu={(event) => openTrackMenu(event, track)}
                    onClick={() => void playerController.playTrackById(track.id, visibleTracks)}
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
                    <div className={styles.trackActions}>
                      <IconPlayerPlay size={18} aria-hidden="true" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
