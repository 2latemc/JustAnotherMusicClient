import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
} from "react";
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
import { isLinux, isMacOS, isWindows } from "../../platform";
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
const BOTTOM_PILL_HEIGHT = 40;
const TOP_PILL_HEIGHT = 28;
const GAP = 2;
const RIGHT_MOUSE_BUTTON = 2;
const LEFT_MOUSE_BUTTON = 0;
const INTERACTIVE_SELECTOR = "button, input, a, [role='button']";

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
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const macAlbumDragActiveRef = useRef(false);
  const macAlbumDragMovedRef = useRef(false);
  const suppressNextAlbumArtClickRef = useRef(false);

  const setIgnoreCursorEventsWhenReady = async (ignore: boolean) => {
    if (isLinux) return;

    await win.setIgnoreCursorEvents(ignore);
  };

  const setExpandedBoth = (value: boolean) => {
    expandedRef.current = value;
    setExpanded(value);
  };

  const saveCurrentPosition = async () => {
    const position = await win.outerPosition();
    const nextPosition = { x: position.x, y: position.y };
    saveMiniPlayerPosition(nextPosition);
    await emit("mini-player:position-changed", nextPosition);
  };

  const saveCurrentPositionSoon = () => {
    window.setTimeout(() => {
      void saveCurrentPosition();
    }, 120);
    window.setTimeout(() => {
      void saveCurrentPosition();
    }, 500);
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
    const setup = async () => {
      const unlisten = await win.onMoved(({ payload }) => {
        const nextPosition = { x: payload.x, y: payload.y };
        saveMiniPlayerPosition(nextPosition);
        void emit("mini-player:position-changed", nextPosition);
      });

      return unlisten;
    };

    const cleanup = setup();
    return () => { cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    if (isMacOS || isLinux) return;

    let isOver = false;
    let hasEnabledPassThrough = false;
    let running = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!running) return;

      try {
        if (!hasEnabledPassThrough) {
          await setIgnoreCursorEventsWhenReady(true);
          hasEnabledPassThrough = true;
        }

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
          await setIgnoreCursorEventsWhenReady(false);
          setExpandedBoth(true);
        } else if (!over && isOver) {
          isOver = false;
          await setIgnoreCursorEventsWhenReady(true);
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

  useEffect(() => {
    if (!isMacOS && !isLinux) return;

    const collapse = () => setExpandedBoth(false);

    window.addEventListener("blur", collapse);
    document.addEventListener("visibilitychange", collapse);

    const setup = async () => {
      const unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
        if (!focused) collapse();
      });
      return () => {
        unlistenFocus();
      };
    };

    const cleanup = setup();
    return () => {
      window.removeEventListener("blur", collapse);
      document.removeEventListener("visibilitychange", collapse);
      void cleanup.then((unlisten) => unlisten());
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

  const stopAlbumArtDrag = async (restoreIfClick: boolean) => {
    if (!macAlbumDragActiveRef.current) return;

    macAlbumDragActiveRef.current = false;
    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    setIsDragging(false);
    try {
      await saveCurrentPosition();
    } catch (_) {}
    try {
      await win.setCursorIcon("grab");
    } catch (_) {}

    const shouldRestore = restoreIfClick && !macAlbumDragMovedRef.current;
    macAlbumDragMovedRef.current = false;
    if (shouldRestore) {
      await handleRestore();
    }
  };

  const handleAlbumArtMouseDown = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.blur();

    if (isLinux && event.button === LEFT_MOUSE_BUTTON) {
      event.stopPropagation();
      suppressNextAlbumArtClickRef.current = true;
      setIsDragging(true);

      const stopNativeDrag = () => {
        setIsDragging(false);
        saveCurrentPositionSoon();
      };
      document.addEventListener("mouseup", stopNativeDrag, { once: true });
      window.addEventListener("blur", stopNativeDrag, { once: true });

      try {
        await win.startDragging();
        saveCurrentPositionSoon();
      } catch (_) {}
      return;
    }

    if (!isMacOS || event.button !== LEFT_MOUSE_BUTTON) return;

    event.stopPropagation();
    suppressNextAlbumArtClickRef.current = true;

    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    const startCursor = await cursorPosition();
    const startPosition = await win.outerPosition();
    macAlbumDragActiveRef.current = true;
    macAlbumDragMovedRef.current = false;
    setIsDragging(true);
    try {
      await win.setCursorIcon("grabbing");
    } catch (_) {}

    const stopDragFromDocument = (upEvent: globalThis.MouseEvent) => {
      if (upEvent.button === LEFT_MOUSE_BUTTON) void stopAlbumArtDrag(true);
    };
    const stopDragOnBlur = () => {
      void stopAlbumArtDrag(false);
    };

    document.addEventListener("mouseup", stopDragFromDocument, { once: true });
    window.addEventListener("blur", stopDragOnBlur, { once: true });

    dragTimerRef.current = setInterval(() => {
      void (async () => {
        if (!macAlbumDragActiveRef.current) return;

        const cursor = await cursorPosition();
        const deltaX = cursor.x - startCursor.x;
        const deltaY = cursor.y - startCursor.y;
        if (Math.hypot(deltaX, deltaY) > 3) {
          macAlbumDragMovedRef.current = true;
        }

        await win.setPosition(new PhysicalPosition(
          startPosition.x + deltaX,
          startPosition.y + deltaY,
        ));
      })();
    }, 16);
  };

  const handleAlbumArtClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (suppressNextAlbumArtClickRef.current) {
      suppressNextAlbumArtClickRef.current = false;
      event.preventDefault();
      return;
    }

    void handleRestore();
  };

  const handleClose = async () => {
    await win.hide();
  };

  const stopManualWindowDrag = async () => {
    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    setIsDragging(false);
    try {
      await saveCurrentPosition();
    } catch (_) {}
    try {
      await win.setCursorIcon("grab");
    } catch (_) {}
    await setIgnoreCursorEventsWhenReady(false);
  };

  const startManualWindowDrag = async (button: number) => {
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
    await setIgnoreCursorEventsWhenReady(false);

    const stopDragFromDocument = (upEvent: globalThis.MouseEvent) => {
      if (upEvent.button === button) void stopManualWindowDrag();
    };
    const stopDragOnBlur = () => {
      void stopManualWindowDrag();
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

  const startNativeWindowDrag = async () => {
    setIsDragging(true);
    const stopNativeDrag = () => {
      setIsDragging(false);
      saveCurrentPositionSoon();
    };
    document.addEventListener("mouseup", stopNativeDrag, { once: true });
    window.addEventListener("blur", stopNativeDrag, { once: true });

    try {
      await win.startDragging();
      saveCurrentPositionSoon();
    } catch (_) {
      setIsDragging(false);
    }
  };

  const handleContainerMouseDown = async (event: MouseEvent<HTMLDivElement>) => {
    const isInteractiveTarget = event.target instanceof Element
      && Boolean(event.target.closest(INTERACTIVE_SELECTOR));

    if (event.button === RIGHT_MOUSE_BUTTON) {
      event.preventDefault();
      event.stopPropagation();
      await startManualWindowDrag(RIGHT_MOUSE_BUTTON);
      return;
    }

    if (event.button === LEFT_MOUSE_BUTTON && !isInteractiveTarget) {
      event.preventDefault();
      if (isWindows) {
        await startManualWindowDrag(LEFT_MOUSE_BUTTON);
        return;
      }

      await startNativeWindowDrag();
    }
  };

  const handleMacPointerEnter = () => {
    if (isMacOS || isLinux) setExpandedBoth(true);
  };

  const handleMacPointerLeave = (event: MouseEvent<HTMLElement>) => {
    if (!isMacOS && !isLinux) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && wrapperRef.current?.contains(nextTarget)) return;
    setExpandedBoth(false);
  };

  const handleMacFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    if (!isMacOS && !isLinux) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && wrapperRef.current?.contains(nextTarget)) return;
    setExpandedBoth(false);
  };

  const isPlaying = playerState.status === "playing";
  const isLoading = playerState.status === "loading";
  const artworkUrl = playerState.artworkUrl ?? cachedArtwork;

  return (
    <div ref={wrapperRef} className={styles.wrapper} onBlur={handleMacFocusOut}>
      <div
        className={`${styles.expandedPill} ${expanded ? styles.expandedPillVisible : ""}`}
        onMouseEnter={handleMacPointerEnter}
        onMouseLeave={handleMacPointerLeave}
      >
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
        onMouseEnter={handleMacPointerEnter}
        onMouseLeave={handleMacPointerLeave}
        onMouseDown={(event) => void handleContainerMouseDown(event)}
        onMouseUp={(event) => {
          if (event.button === RIGHT_MOUSE_BUTTON) void stopManualWindowDrag();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button
          className={styles.albumArt}
          onMouseDown={(event) => void handleAlbumArtMouseDown(event)}
          onClick={handleAlbumArtClick}
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
