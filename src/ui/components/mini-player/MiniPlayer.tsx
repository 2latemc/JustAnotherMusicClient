import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconX,
} from "@tabler/icons-react";
import { saveMiniPlayerPosition } from "../../settings/miniPlayer";
import { TrackArtwork } from "../TrackArtwork";
import styles from "./MiniPlayer.module.css";

interface PlayerSync {
  status: string;
  artworkUrl: string | null;
  title: string | null;
  artist: string | null;
}

interface TimeSync {
  currentTime: number;
  duration: number;
}

const win = getCurrentWindow();
const PILL_WIDTH = 160;
const BOTTOM_PILL_HEIGHT = 60;
const TOP_PILL_HEIGHT = 44;
const GAP = 6;
const RIGHT_MOUSE_BUTTON = 2;

export default function MiniPlayer() {
  const [playerState, setPlayerState] = useState<PlayerSync>({
    status: "idle",
    artworkUrl: null,
    title: null,
    artist: null,
  });
  const [expanded, setExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [timeState, setTimeState] = useState<TimeSync>({ currentTime: 0, duration: 0 });
  const [cachedArtwork, setCachedArtwork] = useState<string | null>(null);
  const expandedRef = useRef(false);
  const dragTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setExpandedBoth = (value: boolean) => {
    expandedRef.current = value;
    setExpanded(value);
  };

  useEffect(() => {
    const setup = async () => {
      const unlisten = await listen<PlayerSync>("player-state-sync", (event) => {
        setPlayerState((previous) => {
          if (event.payload.artworkUrl && event.payload.artworkUrl !== previous.artworkUrl) {
            setCachedArtwork(event.payload.artworkUrl);
          }

          return event.payload;
        });
      });

      return unlisten;
    };

    const cleanup = setup();
    return () => { cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    return () => {
      if (dragTimerRef.current) {
        clearInterval(dragTimerRef.current);
      }
      setIsDragging(false);
    };
  }, []);

  useEffect(() => {
    const setup = async () => {
      const unlisten = await listen<TimeSync>("player-time-sync", (event) => {
        setTimeState(event.payload);
      });

      return unlisten;
    };

    const cleanup = setup();
    return () => { cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    void win.setIgnoreCursorEvents(true);

    let isOver = false;
    let running = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!running) return;

      try {
        const cursor = await cursorPosition();
        const position = await win.outerPosition();
        const size = await win.outerSize();
        const totalHeight = expandedRef.current
          ? BOTTOM_PILL_HEIGHT + GAP + TOP_PILL_HEIGHT
          : BOTTOM_PILL_HEIGHT;

        const pillLeft = position.x + (size.width - PILL_WIDTH) / 2;
        const pillBottom = position.y + size.height;
        const pillTop = pillBottom - totalHeight;
        const pillRight = pillLeft + PILL_WIDTH;
        const over = cursor.x >= pillLeft
          && cursor.x <= pillRight
          && cursor.y >= pillTop
          && cursor.y <= pillBottom;

        if (over && !isOver) {
          isOver = true;
          await win.setIgnoreCursorEvents(false);
          setExpandedBoth(true);
        } else if (!over && isOver) {
          isOver = false;
          await win.setIgnoreCursorEvents(true);
          setExpandedBoth(false);
        }
      } catch (_) {}

      timer = setTimeout(poll, 50);
    };

    poll();
    return () => {
      running = false;
      clearTimeout(timer);
    };
  }, []);

  const handleRestore = async () => {
    await emit("mini-player:restore-main");
    await win.hide();
    const mainWin = await WebviewWindow.getByLabel("main");
    if (mainWin) {
      await mainWin.show();
      await mainWin.unminimize();
      await mainWin.setFocus();
      await win.hide();
    }
  };

  const handleAlbumArtMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.blur();
  };

  const handleClose = async () => {
    await win.hide();
  };

  const stopRightButtonDrag = async () => {
    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    setIsDragging(false);
    try {
      const position = await win.outerPosition();
      saveMiniPlayerPosition({ x: position.x, y: position.y });
    } catch (_) {}
    try {
      await win.setCursorIcon("grab");
    } catch (_) {}
    await win.setIgnoreCursorEvents(false);
  };

  const handleContainerMouseDown = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== RIGHT_MOUSE_BUTTON) return;

    event.preventDefault();
    event.stopPropagation();

    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    const startCursor = await cursorPosition();
    const startPosition = await win.outerPosition();

    setIsDragging(true);
    try {
      await win.setCursorIcon("grabbing");
    } catch (_) {}
    await win.setIgnoreCursorEvents(false);

    const stopDragFromDocument = (upEvent: globalThis.MouseEvent) => {
      if (upEvent.button === RIGHT_MOUSE_BUTTON) void stopRightButtonDrag();
    };
    const stopDragOnBlur = () => {
      void stopRightButtonDrag();
    };

    document.addEventListener("mouseup", stopDragFromDocument, { once: true });
    window.addEventListener("blur", stopDragOnBlur, { once: true });

    dragTimerRef.current = setInterval(() => {
      void (async () => {
        const cursor = await cursorPosition();
        const nextX = startPosition.x + cursor.x - startCursor.x;
        const nextY = startPosition.y + cursor.y - startCursor.y;

        await win.setPosition(new PhysicalPosition(nextX, nextY));
      })();
    }, 16);
  };

  const isPlaying = playerState.status === "playing";
  const isLoading = playerState.status === "loading";
  const artworkUrl = playerState.artworkUrl ?? cachedArtwork;

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.expandedPill} ${expanded ? styles.expandedPillVisible : ""}`}>
        <input
          type="range"
          min={0}
          max={timeState.duration || 100}
          step="any"
          value={timeState.currentTime}
          onChange={(event) => {
            void emit("mini-player:seek", { time: parseFloat(event.target.value) });
          }}
          className={styles.scrubberInput}
          style={{
            "--slider-progress": `${timeState.duration > 0 ? (timeState.currentTime / timeState.duration) * 100 : 0}%`,
          } as CSSProperties}
        />
      </div>

      <div
        className={[
          styles.miniContainer,
          expanded ? styles.miniContainerExpanded : "",
          isDragging ? styles.dragging : "",
        ].filter(Boolean).join(" ")}
        onMouseDown={(event) => void handleContainerMouseDown(event)}
        onMouseUp={(event) => {
          if (event.button === RIGHT_MOUSE_BUTTON) void stopRightButtonDrag();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button
          className={styles.albumArt}
          onMouseDown={handleAlbumArtMouseDown}
          onClick={handleRestore}
          aria-label="Restore"
        >
          <TrackArtwork
            artworkUrl={artworkUrl ?? undefined}
            className={styles.albumArtwork}
            iconSize={18}
            loading="eager"
          />
        </button>

        <div className={styles.controls}>
          <button className={styles.btn} onClick={() => emit("mini-player:skip-previous")} aria-label="Previous">
            <IconPlayerSkipBack size={17} fill="currentColor" aria-hidden="true" />
          </button>
          <button className={styles.btn} onClick={() => emit("mini-player:toggle-play-pause")} aria-label={isLoading ? "Loading song" : isPlaying ? "Pause" : "Play"}>
            <span className={styles.iconStage} aria-hidden="true">
              <span className={`${styles.playbackIcon} ${!isLoading && !isPlaying ? styles.activeIcon : ""}`}>
                <IconPlayerPlay size={17} fill="currentColor" />
              </span>
              <span className={`${styles.playbackIcon} ${!isLoading && isPlaying ? styles.activeIcon : ""}`}>
                <IconPlayerPause size={17} fill="currentColor" />
              </span>
              <span className={`${styles.playbackIcon} ${styles.loadingIcon} ${isLoading ? styles.activeIcon : ""}`}>
                <IconLoader2 size={17} />
              </span>
            </span>
          </button>
          <button className={styles.btn} onClick={() => emit("mini-player:skip-next")} aria-label="Next">
            <IconPlayerSkipForward size={17} fill="currentColor" aria-hidden="true" />
          </button>
        </div>

        <button
          className={`${styles.closeButton} ${expanded ? styles.closeButtonVisible : ""}`}
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void handleClose()}
          aria-label="Close mini player"
        >
          <IconX size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
