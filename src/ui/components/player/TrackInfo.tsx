import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import {
  IconHeart,
  IconHeartBroken,
  IconHeartFilled,
  IconLoader2,
} from "@tabler/icons-react";
import { usePlayerState } from "../../../player/playerStore";
import { useLibraryState } from "../../../player/playerStore";
import { usePlayerUIState } from "../../stores/playerUIStore";
import { TrackArtwork } from "../TrackArtwork";
import { ArtistLinks } from "../ArtistLinks";
import { useTrackContextMenu } from "../TrackContextMenu";
import styles from "./TrackInfo.module.css";

export function TrackInfo() {
  const state = usePlayerState();
  const libraryState = useLibraryState();
  const uiState = usePlayerUIState();
  const { openTrackMenu, toggleTrackLike } = useTrackContextMenu();
  const currentTrack = state.currentTrack;
  const titleViewportRef = useRef<HTMLParagraphElement>(null);
  const titleTextRef = useRef<HTMLSpanElement>(null);
  const [titleScrollDistance, setTitleScrollDistance] = useState(0);

  useLayoutEffect(() => {
    const viewport = titleViewportRef.current;
    const text = titleTextRef.current;
    if (!viewport || !text) return;

    const updateOverflow = () => {
      setTitleScrollDistance(Math.max(0, text.scrollWidth - viewport.clientWidth));
    };
    updateOverflow();

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [currentTrack?.title]);

  if (!currentTrack) {
    return null;
  }

  const isLikeStatusLoading =
    (libraryState.status === "restoring" || libraryState.status === "loading")
    && !libraryState.library;
  const isLikePending = libraryState.pendingLikeTrackIds.has(currentTrack.id);
  const isLiked = libraryState.library?.likedSongs.some(
    (track) => track.id === currentTrack.id,
  ) ?? false;

  return (
    <div
      className={styles.trackInfo}
      onContextMenu={(event) => openTrackMenu(event, currentTrack)}
    >
      {uiState.showAlbumArt && (
        <TrackArtwork
          className={styles.albumArt}
          artworkUrl={currentTrack.artworkUrl}
          iconSize={28}
        />
      )}
      <div className={styles.trackDetails}>
        <p
          ref={titleViewportRef}
          className={`${styles.trackTitle} ${titleScrollDistance > 0 ? styles.scrollingTitle : ""}`}
          title={currentTrack.title}
        >
          <span
            ref={titleTextRef}
            style={{
              "--title-scroll-distance": `${titleScrollDistance}px`,
              "--title-scroll-duration": `${Math.max(7, titleScrollDistance / 24)}s`,
            } as CSSProperties}
          >
            {currentTrack.title}
          </span>
        </p>
        <p className={styles.trackArtist}>
          <ArtistLinks artists={currentTrack.artists} fallback={currentTrack.artist} />
        </p>
      </div>
      <button
        type="button"
        className={`${styles.likeButton} ${isLiked ? styles.liked : ""}`}
        onClick={() => void toggleTrackLike(currentTrack)}
        disabled={isLikeStatusLoading || isLikePending}
        aria-label={
          isLikeStatusLoading || isLikePending
            ? "Loading like status"
            : isLiked
              ? "Remove like"
              : libraryState.status === "signed-out"
                ? "Sign in to like"
                : "Like song"
        }
        title={
          libraryState.status === "signed-out"
            ? "Sign in to like"
            : isLiked
              ? "Remove like"
              : "Like song"
        }
      >
        {isLikeStatusLoading || isLikePending ? (
          <IconLoader2 className={styles.likeLoadingIcon} size={18} />
        ) : isLiked ? (
          <span className={styles.likedIconStage} aria-hidden="true">
            <IconHeartFilled className={styles.likedHeartIcon} size={18} />
            <IconHeartBroken className={styles.removeLikeIcon} size={18} />
          </span>
        ) : (
          <IconHeart size={18} />
        )}
      </button>
    </div>
  );
}
