import {
  IconArrowsShuffle,
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconRepeat,
  IconRepeatOff,
} from "@tabler/icons-react";
import { usePlayerState } from "../../../player/playerStore";
import { playerController } from "../../../player/playerStore";
import styles from "./PlaybackControls.module.css";

interface PlaybackControlsProps {
  extraControlsAlwaysVisible?: boolean;
}

export function PlaybackControls({ extraControlsAlwaysVisible = true }: PlaybackControlsProps) {
  const state = usePlayerState();
  const isBusy = state.status === "loading";
  const isPlaying = state.status === "playing";
  const hasCurrentTrack = Boolean(state.currentTrack);

  const handlePlayPause = () => {
    void playerController.togglePlayPause();
  };

  const handleSkipNext = () => {
    void playerController.skipToNext();
  };

  const handleSkipPrevious = () => {
    void playerController.skipToPrevious();
  };

  const handlePlaybackOrderCycle = () => {
    playerController.cyclePlaybackOrderMode();
  };

  return (
    <div className={styles.playbackControls}>
      <button
        type="button"
        className={`${styles.controlButton} ${styles.skipButton}`}
        onClick={handleSkipPrevious}
        disabled={!hasCurrentTrack}
        aria-label="Previous track"
      >
        <IconPlayerSkipBack size={20} />
      </button>

      <button
        type="button"
        className={`${styles.controlButton} ${styles.playPauseButton}`}
        onClick={handlePlayPause}
        disabled={isBusy || !hasCurrentTrack}
        aria-label={isBusy ? "Loading song" : isPlaying ? "Pause" : "Play"}
      >
        <span className={styles.iconStage} aria-hidden="true">
          <span className={`${styles.playbackIcon} ${!isBusy && !isPlaying ? styles.activeIcon : ""}`}>
            <IconPlayerPlay size={20} />
          </span>
          <span className={`${styles.playbackIcon} ${!isBusy && isPlaying ? styles.activeIcon : ""}`}>
            <IconPlayerPause size={20} />
          </span>
          <span
            className={`${styles.playbackIcon} ${styles.loadingIcon} ${isBusy ? styles.activeIcon : ""}`}
          >
            <IconLoader2 size={20} />
          </span>
        </span>
      </button>

      <button
        type="button"
        className={`${styles.controlButton} ${styles.skipButton}`}
        onClick={handleSkipNext}
        disabled={!hasCurrentTrack}
        aria-label="Next track"
      >
        <IconPlayerSkipForward size={20} />
      </button>

      <div
        className={`${styles.extraControl} ${
          extraControlsAlwaysVisible ? "" : styles.extraControlHoverOnly
        }`}
      >
        <button
          type="button"
          className={`${styles.controlButton} ${styles.skipButton}`}
          onClick={handlePlaybackOrderCycle}
          aria-label={
            state.playbackOrderMode === "repeat-one"
              ? "Loop current song"
              : state.playbackOrderMode === "shuffle"
                ? "Shuffle playback"
                : "Play in order"
          }
          title={
            state.playbackOrderMode === "repeat-one"
              ? "Loop current song"
              : state.playbackOrderMode === "shuffle"
                ? "Shuffle"
                : "In order"
          }
        >
          {state.playbackOrderMode === "repeat-one" ? (
            <IconRepeat size={20} />
          ) : state.playbackOrderMode === "shuffle" ? (
            <IconArrowsShuffle size={20} />
          ) : (
            <IconRepeatOff size={20} />
          )}
        </button>
      </div>
    </div>
  );
}
