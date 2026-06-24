import { useEffect, useMemo } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PlayerState } from "./PlayerController";
import type { PlayerControllerActions } from "./playerStore";
import { logInternalWarn } from "../internal/logging";

type NativeMediaAction =
  | "play"
  | "pause"
  | "next"
  | "previous"
  | { action: "seekTo"; positionSec: number };

const usesNativeWindowsMediaSession =
  isTauri() && /Windows/i.test(navigator.userAgent);
const usesNativeMediaSession =
  usesNativeWindowsMediaSession;

function getNativeMediaCommand(): string | null {
  if (usesNativeWindowsMediaSession) return "update_windows_media_session";
  return null;
}

function getNativeMediaControlEvent(): string | null {
  if (usesNativeWindowsMediaSession) return "windows-media-control";
  return null;
}

function getBrowserPlaybackState(status: PlayerState["status"]): MediaSessionPlaybackState {
  if (status === "playing" || status === "loading") return "playing";
  if (status === "paused") return "paused";
  return "none";
}

function getClampedPosition(duration: number, position: number): number {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  if (!Number.isFinite(duration) || duration <= 0) return safePosition;
  return Math.min(duration, safePosition);
}

export function useMediaSession(
  state: PlayerState,
  controller: PlayerControllerActions,
): void {
  const nativeMediaCommand = useMemo(getNativeMediaCommand, []);
  const nativeMediaControlEvent = useMemo(getNativeMediaControlEvent, []);

  useEffect(() => {
    if (!nativeMediaControlEvent) return;

    const unlistenPromise = listen<NativeMediaAction>(
      nativeMediaControlEvent,
      ({ payload }) => {
        if (typeof payload === "object") {
          if (payload.action === "seekTo") void controller.seekTo(payload.positionSec);
          return;
        }

        if (payload === "play") void controller.play();
        if (payload === "pause") void controller.pause();
        if (payload === "next") void controller.skipToNext();
        if (payload === "previous") void controller.skipToPrevious();
      },
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [controller, nativeMediaControlEvent]);

  useEffect(() => {
    if (!nativeMediaCommand) return;

    const track = state.currentTrack;
    const duration = controller.getDuration() || track?.durationSec || 0;
    void invoke(nativeMediaCommand, {
      update: {
        title: track?.title ?? null,
        artist: track?.artist ?? null,
        artworkUrl: track?.artworkUrl ?? null,
        status: state.status,
        durationSec: duration || null,
        positionSec: getClampedPosition(duration, controller.getCurrentTime()),
      },
    }).catch((error) => {
      logInternalWarn("useMediaSession native update failed", {
        error: String(error),
      });
    });
  }, [controller, nativeMediaCommand, state.currentTrack, state.status]);

  useEffect(() => {
    if (!nativeMediaCommand || !state.currentTrack) return;

    const updateNativePosition = () => {
      const duration = controller.getDuration() || state.currentTrack?.durationSec || 0;
      void invoke(nativeMediaCommand, {
        update: {
          title: state.currentTrack?.title ?? null,
          artist: state.currentTrack?.artist ?? null,
          artworkUrl: state.currentTrack?.artworkUrl ?? null,
          status: state.status,
          durationSec: duration || null,
          positionSec: getClampedPosition(duration, controller.getCurrentTime()),
        },
      }).catch((error) => {
        logInternalWarn("useMediaSession native position update failed", {
          error: String(error),
        });
      });
    };

    updateNativePosition();
    const intervalId = window.setInterval(updateNativePosition, 1000);
    return () => window.clearInterval(intervalId);
  }, [controller, nativeMediaCommand, state.currentTrack, state.status]);

  useEffect(() => {
    if (usesNativeMediaSession || !("mediaSession" in navigator)) return;

    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => void controller.play(),
      pause: () => void controller.pause(),
      stop: () => void controller.pause(),
      nexttrack: () => void controller.skipToNext(),
      previoustrack: () => void controller.skipToPrevious(),
      seekto: (details) => {
        if (details.seekTime !== undefined) void controller.seekTo(details.seekTime);
      },
      seekbackward: (details) => {
        const offset = details.seekOffset ?? 10;
        void controller.seekTo(Math.max(0, controller.getCurrentTime() - offset));
      },
      seekforward: (details) => {
        const duration = controller.getDuration();
        const offset = details.seekOffset ?? 10;
        void controller.seekTo(Math.min(duration, controller.getCurrentTime() + offset));
      },
    };

    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(
          action as MediaSessionAction,
          handler as MediaSessionActionHandler,
        );
      } catch {
        // WebView media-session support varies by installed runtime version.
      }
    }

    return () => {
      for (const action of Object.keys(handlers) as MediaSessionAction[]) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore actions unsupported by the current WebView runtime.
        }
      }
    };
  }, [controller]);

  useEffect(() => {
    if (usesNativeMediaSession || !("mediaSession" in navigator)) return;

    const track = state.currentTrack;
    try {
      navigator.mediaSession.metadata = track
        ? new MediaMetadata({
            title: track.title,
            artist: track.artist,
            artwork: track.artworkUrl ? [{ src: track.artworkUrl }] : [],
          })
        : null;
      navigator.mediaSession.playbackState = getBrowserPlaybackState(state.status);
    } catch {
      // WebView media-session support varies by installed runtime version.
    }
  }, [state.currentTrack, state.status]);

  useEffect(() => {
    if (
      usesNativeMediaSession
      || !("mediaSession" in navigator)
      || !state.currentTrack
    ) return;

    const updatePosition = () => {
      const duration = controller.getDuration() || state.currentTrack?.durationSec || 0;
      const position = Math.min(duration, Math.max(0, controller.getCurrentTime()));
      if (duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: 1,
            position,
          });
        } catch {
          // WebView media-session support varies by installed runtime version.
        }
      }
    };

    updatePosition();
    const intervalId = window.setInterval(updatePosition, 1000);
    return () => window.clearInterval(intervalId);
  }, [controller, state.currentTrack, state.status]);
}
