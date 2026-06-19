import { useState, useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow, PhysicalPosition, primaryMonitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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

export default function MiniPlayer() {
  const [playerState, setPlayerState] = useState<PlayerSync>({
    status: "idle",
    artworkUrl: null,
    title: null,
    artist: null,
  });
  const [expanded, setExpanded] = useState(false);
  const [timeState, setTimeState] = useState<TimeSync>({ currentTime: 0, duration: 0 });
const [cachedArtwork, setCachedArtwork] = useState<string | null>(null);

const expandedRef = useRef(false);

const setExpandedBoth = (val: boolean) => {
  expandedRef.current = val;
  setExpanded(val);
};
  useEffect(() => {
    const setup = async () => {
      const unlisten = await listen<PlayerSync>("player-state-sync", (event) => {
       setPlayerState(prev => {
        // only update artwork if it actually changed
        if (event.payload.artworkUrl !== prev.artworkUrl) {
          setCachedArtwork(event.payload.artworkUrl);
        }
        return event.payload;
      });
      });
      return unlisten;
    };
    const cleanup = setup();
    return () => { cleanup.then(fn => fn()); };
  }, []);

  useEffect(() => {
    let unlisten: () => void;
    let debounceTimer: ReturnType<typeof setTimeout>;

    const setup = async () => {
      const monitor = await primaryMonitor();
      if (!monitor) return;

      const screenPos = monitor.position;
      const screenSize = monitor.size;

      unlisten = await win.listen("tauri://move", async () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const position = await win.outerPosition();
          const size = await win.outerSize();

          const minX = screenPos.x;
          const minY = screenPos.y;
          const maxX = screenPos.x + screenSize.width - size.width;
          const maxY = screenPos.y + screenSize.height - size.height;

          const clampedX = Math.min(Math.max(position.x, minX), maxX);
          const clampedY = Math.min(Math.max(position.y, minY), maxY);

          if (clampedX !== position.x || clampedY !== position.y) {
            await win.setPosition(new PhysicalPosition(clampedX, clampedY));
          }
        }, 100);
      });
    };

    setup();
    return () => {
      if (unlisten) unlisten();
      clearTimeout(debounceTimer);
    };
  }, []);

useEffect(() => {
    win.setIgnoreCursorEvents(true);

    const PILL_WIDTH = 200;
    const BOTTOM_PILL_HEIGHT = 60;
    const TOP_PILL_HEIGHT = 44;
    const GAP = 6;

    let isOver = false;
    let running = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!running) return;
      try {
        const cursor = await cursorPosition();
        const position = await win.outerPosition();
        const size = await win.outerSize();

        // compute inside poll so it always uses latest expandedRef value
        const TOTAL_HEIGHT = expandedRef.current
          ? BOTTOM_PILL_HEIGHT + GAP + TOP_PILL_HEIGHT
          : BOTTOM_PILL_HEIGHT;

        const pillLeft = position.x + (size.width - PILL_WIDTH) / 2;
        const pillBottom = position.y + size.height;
        const pillTop = pillBottom - TOTAL_HEIGHT;
        const pillRight = pillLeft + PILL_WIDTH;

        const over =
          cursor.x >= pillLeft &&
          cursor.x <= pillRight &&
          cursor.y >= pillTop &&
          cursor.y <= pillBottom;

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
  const isPlaying = playerState.status === "playing";
  const albumArt = playerState.artworkUrl;

  const handleRestore = async () => {
    await win.hide();
    const mainWin = await WebviewWindow.getByLabel("main");
    if (mainWin) {
      await mainWin.unminimize();
      await mainWin.setFocus();
    }
  };




useEffect(() => {
  const setup = async () => {
    const unlisten = await listen<TimeSync>("player-time-sync", (event) => {
      setTimeState(event.payload);
    });
    return unlisten;
  };
  const cleanup = setup();
  return () => { cleanup.then(fn => fn()); };
}, []);

  return (
  
  <div className={styles.wrapper}>
    
    {/* top pill — scrubber, slides in above */}
    <div className={`${styles.expandedPill} ${expanded ? styles.expandedPillVisible : ""}`}>
   <input
    type="range"
    min={0}
    max={timeState.duration || 100}
    step="any"
    value={timeState.currentTime}
    onChange={(e) => {
      void emit("mini-player:seek", { time: parseFloat(e.target.value) });
    }}
    className={styles.scrubberInput}
    style={{
      "--slider-progress": `${timeState.duration > 0 ? (timeState.currentTime / timeState.duration) * 100 : 0}%`,
    } as React.CSSProperties}
  />  {/* <div data-tauri-drag-region>Move</div> */}
    </div>

    {/* bottom pill — always visible, never moves */}
    <div data-tauri-drag-region className={styles.miniContainer}>
      <button className={styles.albumArt} onClick={handleRestore} aria-label="Restore">
         {cachedArtwork
    ? <img src={cachedArtwork} alt="" className={styles.albumImg} />
    : <div className={styles.albumPlaceholder}>♪</div>
  }
      </button>
      <div className={styles.controls}>
        <button className={styles.btn} onClick={() => emit("mini-player:skip-previous")} aria-label="Previous">⏮</button>
        <button className={styles.btn} onClick={() => emit("mini-player:toggle-play-pause")} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button className={styles.btn} onClick={() => emit("mini-player:skip-next")} aria-label="Next">⏭</button>
      </div>
    </div>

  </div>
);
  
}