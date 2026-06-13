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
  const seekAnimationRef = useRef<number | null>(null);
  const seekAnimationDoneRef = useRef<(() => void) | null>(null);
  const seekAnimationPromiseRef = useRef<Promise<void> | null>(null);
  const pendingSeekRef = useRef<{ target: number; startedAt: number } | null>(null);
  const displayedTimeRef = useRef(0);
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const isPointerDownRef = useRef(false);
  const isDraggingRef = useRef(false);

  const setDisplayedTime = (time: number) => {
    displayedTimeRef.current = time;
    setCurrentTime(time);
  };

  const cancelSeekAnimation = () => {
    if (seekAnimationRef.current !== null) {
      cancelAnimationFrame(seekAnimationRef.current);
      seekAnimationRef.current = null;
    }
    seekAnimationDoneRef.current?.();
    seekAnimationDoneRef.current = null;
    seekAnimationPromiseRef.current = null;
  };

  const animateTo = (target: number) => {
    cancelSeekAnimation();

    const start = displayedTimeRef.current;
    const startedAt = performance.now();
    const done = new Promise<void>((resolve) => {
      seekAnimationDoneRef.current = resolve;
    });
    seekAnimationPromiseRef.current = done;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 120);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayedTime(start + (target - start) * eased);

      if (progress < 1) {
        seekAnimationRef.current = requestAnimationFrame(animate);
      } else {
        seekAnimationRef.current = null;
        seekAnimationDoneRef.current?.();
        seekAnimationDoneRef.current = null;
        seekAnimationPromiseRef.current = null;
      }
    };

    seekAnimationRef.current = requestAnimationFrame(animate);
    return done;
  };

  useEffect(() => () => cancelSeekAnimation(), []);

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
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    isPointerDownRef.current = true;
    isDraggingRef.current = false;
    seekTargetRef.current = displayedTimeRef.current;
    playerUIStore.setSeeking(true);
  };

  const handleSeekMove = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!isPointerDownRef.current || isDraggingRef.current) return;

    const distance = Math.hypot(
      event.clientX - pointerStartRef.current.x,
      event.clientY - pointerStartRef.current.y,
    );
    if (distance < 3) return;

    isDraggingRef.current = true;
    cancelSeekAnimation();
    const target = Number(event.currentTarget.value);
    seekTargetRef.current = target;
    setDisplayedTime(target);
  };

  const handleSeekEnd = async (_event: React.PointerEvent<HTMLInputElement>) => {
    const wasDragging = isDraggingRef.current;
    isPointerDownRef.current = false;
    isDraggingRef.current = false;
    const seekTime = Number(event.currentTarget.value);
    seekTargetRef.current = seekTime;
    const animationDone = wasDragging
      ? Promise.resolve()
      : (seekAnimationPromiseRef.current ?? Promise.resolve());

    try {
      pendingSeekRef.current = { target: seekTime, startedAt: performance.now() };
      await Promise.all([playerController.seekTo(seekTime), animationDone]);
    } finally {
      playerUIStore.setSeeking(false);
    }
  };

  const handleSeekCancel = () => {
    isPointerDownRef.current = false;
    isDraggingRef.current = false;
    cancelSeekAnimation();
    playerUIStore.setSeeking(false);
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = parseFloat(e.target.value);
    seekTargetRef.current = target;

    if (isDraggingRef.current || !isPointerDownRef.current) {
      cancelSeekAnimation();
      setDisplayedTime(target);
      return;
    }

    void animateTo(target);
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
        onPointerMove={handleSeekMove}
        onPointerUp={(event) => void handleSeekEnd(event)}
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
