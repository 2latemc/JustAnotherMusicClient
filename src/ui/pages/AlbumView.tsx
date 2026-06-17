import { useEffect, useState } from "react";
import { IconArrowsShuffle, IconPlayerPlay } from "@tabler/icons-react";
import type { Album, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { shuffleTracks } from "../../player/shuffleTracks";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { ArtistLinks } from "../components/ArtistLinks";
import { TrackArtwork } from "../components/TrackArtwork";
import styles from "./AlbumView.module.css";

interface AlbumViewProps {
  album?: Album;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
}

export function AlbumView({ album, playerController, libraryController }: AlbumViewProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!album) return;
    let active = true;
    setTracks([]);
    setIsLoading(true);
    setError(null);
    void libraryController.getAlbumTracks(album, (updatedTracks) => {
      if (active) setTracks(updatedTracks);
    })
      .then((items) => {
        if (active) setTracks(items);
      })
      .catch(() => {
        if (active) setError("Unable to load this album.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [album, libraryController]);

  if (!album) return null;

  const playShuffled = () => {
    const shuffledTracks = shuffleTracks(tracks);
    const firstTrack = shuffledTracks[0];
    if (firstTrack) void playerController.playTrackById(firstTrack.id, shuffledTracks);
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
      {isLoading && <p className={styles.message}>Loading songs...</p>}
      {error && <p className={styles.message}>{error}</p>}
      {!isLoading && !error && (
        <div className={styles.trackList}>
          {tracks.map((track, index) => (
            <button
              key={track.id}
              className={styles.track}
              onContextMenu={(event) => openTrackMenu(event, track)}
              onClick={() => void playerController.playTrackById(track.id, tracks)}
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
