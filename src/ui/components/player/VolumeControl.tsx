import { IconVolume, IconVolumeOff } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { playerController, usePlayerState } from "../../../player/playerStore";
import styles from "./VolumeControl.module.css";

export function VolumeControl() {
  const playerState = usePlayerState();
  const sliderRef = useRef<HTMLInputElement>(null);
  const [volume, setVolume] = useState(() => playerController.getVolume());
  const [isMuted, setIsMuted] = useState(() => playerController.isMuted());
  const [displayedVolume, setDisplayedVolume] = useState(
    () => playerController.isMuted() ? 0 : playerController.getVolume(),
  );
  const displayedVolumeRef = useRef(displayedVolume);
  const volumeAnimationRef = useRef<number | null>(null);
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const isPointerDownRef = useRef(false);
  const isDraggingRef = useRef(false);

  const setVolumeDisplay = (value: number) => {
    displayedVolumeRef.current = value;
    setDisplayedVolume(value);
  };

  const cancelVolumeAnimation = () => {
    if (volumeAnimationRef.current !== null) {
      cancelAnimationFrame(volumeAnimationRef.current);
      volumeAnimationRef.current = null;
    }
  };

  const animateVolumeTo = (target: number) => {
    cancelVolumeAnimation();

    const start = displayedVolumeRef.current;
    const startedAt = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 120);
      const eased = 1 - Math.pow(1 - progress, 3);
      setVolumeDisplay(start + (target - start) * eased);

      if (progress < 1) {
        volumeAnimationRef.current = requestAnimationFrame(animate);
      } else {
        volumeAnimationRef.current = null;
      }
    };

    volumeAnimationRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    setVolume(playerState.volume);
    setIsMuted(playerState.muted);
    setVolumeDisplay(playerState.muted ? 0 : playerState.volume);
  }, [playerState.muted, playerState.volume]);

  useEffect(() => () => {
    cancelVolumeAnimation();
  }, []);

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) {
      return;
    }

    const preventBackgroundScroll = (event: WheelEvent) => {
      event.preventDefault();
    };

    slider.addEventListener("wheel", preventBackgroundScroll, { passive: false });
    return () => slider.removeEventListener("wheel", preventBackgroundScroll);
  }, []);

  const updateVolume = (value: number, updateDisplay = true) => {
    const clampedValue = Math.min(1, Math.max(0, value));
    const roundedValue = Math.round(clampedValue * 100) / 100;

    setVolume(roundedValue);
    if (updateDisplay) {
      cancelVolumeAnimation();
      setVolumeDisplay(roundedValue);
    }
    const shouldBeMuted = roundedValue === 0;
    if (isMuted !== shouldBeMuted) {
      setIsMuted(shouldBeMuted);
      void playerController.toggleMute();
    }
    void playerController.setVolume(roundedValue);
  };

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(event.target.value);
    const shouldAnimate = isPointerDownRef.current && !isDraggingRef.current;
    updateVolume(value, !shouldAnimate);
    if (shouldAnimate) {
      animateVolumeTo(value);
    }
  };

  const handleVolumePointerDown = (event: React.PointerEvent<HTMLInputElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    isPointerDownRef.current = true;
    isDraggingRef.current = false;
  };

  const handleVolumePointerMove = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!isPointerDownRef.current || isDraggingRef.current) return;

    const distance = Math.hypot(
      event.clientX - pointerStartRef.current.x,
      event.clientY - pointerStartRef.current.y,
    );
    if (distance < 3) return;

    isDraggingRef.current = true;
    cancelVolumeAnimation();
    setVolumeDisplay(Number(event.currentTarget.value));
  };

  const handleVolumePointerEnd = () => {
    isPointerDownRef.current = false;
    isDraggingRef.current = false;
  };

  const handleVolumeWheel = (event: React.WheelEvent<HTMLInputElement>) => {
    event.preventDefault();

    const scrollDelta = event.deltaY || event.deltaX;
    if (scrollDelta === 0) {
      return;
    }

    const currentVolume = isMuted ? 0 : volume;
    const direction = scrollDelta < 0 ? 1 : -1;
    updateVolume(currentVolume + direction * 0.05);
  };

  const handleToggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    animateVolumeTo(nextMuted ? 0 : volume);
    void playerController.toggleMute();
  };

  return (
    <div className={styles.volumeControl}>
      <button
        type="button"
        className={styles.muteButton}
        onClick={handleToggleMute}
        aria-label={isMuted ? "Unmute" : "Mute"}
      >
        {isMuted ? <IconVolumeOff size={18} /> : <IconVolume size={18} />}
      </button>
      <input
        ref={sliderRef}
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={displayedVolume}
        onChange={handleVolumeChange}
        onPointerDown={handleVolumePointerDown}
        onPointerMove={handleVolumePointerMove}
        onPointerUp={handleVolumePointerEnd}
        onPointerCancel={handleVolumePointerEnd}
        onWheel={handleVolumeWheel}
        className={styles.volumeSlider}
        style={{
          "--slider-progress": `${displayedVolume * 100}%`,
        } as React.CSSProperties}
        aria-label="Volume"
      />
    </div>
  );
}
