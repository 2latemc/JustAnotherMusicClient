import { useEffect, useRef, useState } from "react";
import { usePlayerState } from "../../../player/playerStore";
import { playerController } from "../../../player/playerStore";
import { playerUIStore, usePlayerUIState } from "../../stores/playerUIStore";
import styles from "./SeekBar.module.css";

function formatTime(seconds: number): string {
  if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function SeekBar() {
  const state = usePlayerState();
  const uiState = usePlayerUIState();
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const seekTargetRef = useRef(0);
  const pendingSeekRef = useRef<{ target: number; startedAt: number } | null>(null);
  const displayedTimeRef = useRef(0);
  const isPointerDownRef = useRef(false);

  const setDisplayedTime = (time: number) => {
    displayedTimeRef.current = time;
    setCurrentTime(time);
  };

  useEffect(() => {
    let animationFrameId = 0;
    const update = () => {
      if (!uiState.isSeeking) {
        const engineTime = playerController.getCurrentTime();
        const pendingSeek = pendingSeekRef.current;
        if (
          pendingSeek
          && performance.now() - pendingSeek.startedAt < 750
          && Math.abs(engineTime - pendingSeek.target) > 0.75
        ) {
          setDisplayedTime(pendingSeek.target);
        } else {
          pendingSeekRef.current = null;
          setDisplayedTime(engineTime);
        }
        setDuration(playerController.getDuration());
      }
      animationFrameId = requestAnimationFrame(update);
    };
    animationFrameId = requestAnimationFrame(update);

    return () => cancelAnimationFrame(animationFrameId);
  }, [uiState.isSeeking, state.status]);

  const handleSeekStart = (event: React.PointerEvent<HTMLInputElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    isPointerDownRef.current = true;
    seekTargetRef.current = displayedTimeRef.current;
    playerUIStore.setSeeking(true);
  };

  const handleSeekEnd = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!isPointerDownRef.current) return;
    isPointerDownRef.current = false;
    const seekTime = Number(event.currentTarget.value);
    seekTargetRef.current = seekTime;
    setDisplayedTime(seekTime);
    pendingSeekRef.current = { target: seekTime, startedAt: performance.now() };
    playerUIStore.setSeeking(false);
    void playerController.seekTo(seekTime);
  };

  const handleSeekCancel = () => {
    isPointerDownRef.current = false;
    playerUIStore.setSeeking(false);
    setDisplayedTime(playerController.getCurrentTime());
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = parseFloat(e.target.value);
    seekTargetRef.current = target;
    setDisplayedTime(target);
  };

  const commitKeyboardSeek = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      return;
    }
    const seekTime = seekTargetRef.current;
    pendingSeekRef.current = { target: seekTime, startedAt: performance.now() };
    void playerController.seekTo(seekTime);
  };

  const isDisabled = !state.currentTrack || state.status === "loading";

  return (
    <div className={styles.seekBar}>
      <span className={styles.timeDisplay}>{formatTime(currentTime)}</span>
      <input
        type="range"
        min="0"
        max={duration || 100}
        step="any"
        value={currentTime}
        onChange={handleSeekChange}
        onKeyUp={commitKeyboardSeek}
        onPointerDown={handleSeekStart}
        onPointerUp={handleSeekEnd}
        onPointerCancel={handleSeekCancel}
        disabled={isDisabled}
        className={styles.seekSlider}
        style={{
          "--slider-progress": `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
        } as React.CSSProperties}
        aria-label="Seek"
      />
      <span className={styles.timeDisplay}>{formatTime(duration)}</span>
    </div>
  );
}
