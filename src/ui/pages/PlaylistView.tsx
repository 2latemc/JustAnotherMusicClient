import { useEffect, useState } from "react";
import { IconArrowsShuffle, IconHeart, IconPlayerPlay } from "@tabler/icons-react";
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

export function PlaylistView({ playlist, playerController, libraryController }: PlaylistViewProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu } = usePlaylistContextMenu();
  const libraryState = useLibraryState();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!playlist) return;
    let active = true;
    const isLikedSongs = playlist.kind === "liked-songs" || playlist.id === "LM";
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
    setTracks((current) => current.filter((item) =>
      playlist.kind === "liked-songs" || playlist.id === "LM"
        ? item.id !== removedTrack.id
        : item.playlistItemId !== removedTrack.playlistItemId
    ));
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
        <div className={styles.trackList}>
          {tracks.map((track, index) => (
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
      )}
    </div>
  );
}
