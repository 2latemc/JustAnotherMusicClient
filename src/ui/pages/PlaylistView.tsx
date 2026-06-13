import { useEffect, useLayoutEffect, useState } from "react";
import { IconArrowsShuffle, IconPlayerPlay, IconPlaylist } from "@tabler/icons-react";
import type { Playlist, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { markPlaylistPlayed } from "../../player/recentPlaylists";
import { shuffleTracks } from "../../player/shuffleTracks";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import styles from "./AlbumView.module.css";

interface PlaylistViewProps {
  playlist?: Playlist;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
}

export function PlaylistView({ playlist, playerController, libraryController }: PlaylistViewProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [artworkFailed, setArtworkFailed] = useState(false);
  const [artworkLoaded, setArtworkLoaded] = useState(false);

  useLayoutEffect(() => {
    setArtworkFailed(false);
    setArtworkLoaded(false);
  }, [playlist?.id, playlist?.artworkUrl]);

  useEffect(() => {
    if (!playlist) return;
    let active = true;
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

  if (!playlist) return null;

  const playPlaylistTrack = async (track: Track) => {
    const started = await playerController.playTrackById(track.id, tracks);
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
    setTracks((current) => current.filter((item) => item.id !== removedTrack.id));
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={`${styles.cover} ${styles.coverFrame}`}>
          {(!playlist.artworkUrl || artworkFailed) && (
            <IconPlaylist size={80} aria-hidden="true" />
          )}
          {playlist.artworkUrl && !artworkFailed && (
            <img
              className={`${styles.coverImage} ${artworkLoaded ? styles.coverImageLoaded : ""}`}
              src={playlist.artworkUrl}
              alt=""
              onLoad={() => setArtworkLoaded(true)}
              onError={() => setArtworkFailed(true)}
            />
          )}
        </div>
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
        <div className={styles.trackList}>
          {tracks.map((track, index) => (
            <button
              key={track.id}
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
                <span className={styles.trackArtist}>{track.artist}</span>
              </span>
              <IconPlayerPlay size={18} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
