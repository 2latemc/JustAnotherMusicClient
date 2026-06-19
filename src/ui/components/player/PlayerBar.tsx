import { useCallback, useEffect, useRef, useState } from "react";
import { IconPlayerPlay, IconPlaylist } from "@tabler/icons-react";
import { tauriFetch } from "../../../datasource/youtube/tauriFetch";
import { TrackInfo } from "./TrackInfo";
import { PlaybackControls } from "./PlaybackControls";
import { SeekBar } from "./SeekBar";
import { VolumeControl } from "./VolumeControl";
import { LyricsButton } from "./LyricsButton";
import { useExtraPlayerControlsAlwaysVisible } from "../../settings/playerControls";
import styles from "./PlayerBar.module.css";

interface PlayerBarProps {
  onToggleLyrics: () => void;
  onToggleQueue: () => void;
  isQueueOpen: boolean;
  onConnectionRestored: () => Promise<void>;
  handlePlayerBarClick:()=>void;
}

const CONNECTION_CHECK_URLS = [
  "https://music.youtube.com/",
  "https://cp.cloudflare.com/generate_204",
];

export function PlayerBar({ onToggleLyrics, onToggleQueue, isQueueOpen, onConnectionRestored,handlePlayerBarClick }: PlayerBarProps) {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
 
  const connectionCheckRef = useRef<Promise<boolean> | null>(null);
  const wasOfflineRef = useRef(!navigator.onLine);
  const recoveryStartedRef = useRef(false);
  const failedChecksRef = useRef(0);

  const updateConnectionState = useCallback((connected: boolean) => {
    if (connected) failedChecksRef.current = 0;
    setIsOnline(connected);

    if (!connected) {
      wasOfflineRef.current = true;
      return;
    }

    if (wasOfflineRef.current && !recoveryStartedRef.current) {
      recoveryStartedRef.current = true;
      void onConnectionRestored();
    }
  }, [onConnectionRestored]);

  const checkConnection = useCallback(async () => {
    if (connectionCheckRef.current) return connectionCheckRef.current;

    const check = (async () => {
      if (!navigator.onLine) {
        failedChecksRef.current += 1;
        if (failedChecksRef.current >= 2) {
          updateConnectionState(false);
        } else {
          window.setTimeout(() => void checkConnection(), 1500);
        }
        return false;
      }

      const checks = await Promise.allSettled(
        CONNECTION_CHECK_URLS.map((url) =>
          tauriFetch(url, {
            cache: "no-store",
            method: "GET",
          })
        ),
      );
      const connected = checks.some((result) => result.status === "fulfilled");
      if (connected) {
        updateConnectionState(true);
      } else {
        failedChecksRef.current += 1;
        if (failedChecksRef.current >= 2) {
          updateConnectionState(false);
        } else {
          window.setTimeout(() => void checkConnection(), 1500);
        }
      }
      return connected;
    })();

    connectionCheckRef.current = check;
    try {
      return await check;
    } finally {
      connectionCheckRef.current = null;
    }
  }, [updateConnectionState]);

  useEffect(() => {
    const handleOnline = () => void checkConnection();
    const handleOffline = () => void checkConnection();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkConnection();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void checkConnection();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkConnection, updateConnectionState]);

  useEffect(() => {
    if (isOnline) return;

    const retryTimer = window.setInterval(() => {
      void checkConnection();
    }, 5000);

    return () => window.clearInterval(retryTimer);
  }, [checkConnection, isOnline]);

  const reconnect = async () => {
    setIsCheckingConnection(true);

    try {
      await checkConnection();
    } finally {
      setIsCheckingConnection(false);
    }
  };

  const extraControlsAlwaysVisible = useExtraPlayerControlsAlwaysVisible();



  return (
    <>
      {!isOnline && (
        <div className={styles.offlinePrompt} role="status" aria-live="polite">
          <span className={styles.offlineMessage}>You don't have an internet connection</span>
          <button
            type="button"
            className={styles.reconnectButton}
            onClick={() => void reconnect()}
            disabled={isCheckingConnection}
            aria-label="Reconnect to the internet"
          >
            <IconPlayerPlay
              className={isCheckingConnection ? styles.checkingIcon : undefined}
              size={14}
              fill="currentColor"
              aria-hidden="true"
            />
            <span>{isCheckingConnection ? "Checking" : "Reconnect"}</span>
          </button>
        </div>
      )}


      <div className={styles.playerBar} onClick={handlePlayerBarClick}>
   
        <div className={styles.seekBarContainer}>
          <SeekBar />
        </div>

        <div className={styles.controlsRow}>
          <div className={styles.leftSection}>
            <TrackInfo />
          </div>

          <div className={styles.centerSection}>
            <PlaybackControls extraControlsAlwaysVisible={extraControlsAlwaysVisible} />
          </div>

          <div className={styles.rightSection}>
            <div
              className={`${styles.volumeControlsWrapper} ${
                extraControlsAlwaysVisible ? "" : styles.controlsHoverOnly
              }`}
            >
              <div className={styles.expandedControls}>
                <LyricsButton onToggle={onToggleLyrics} />

                <button
                  type="button"
                  className={`${styles.iconButton} ${isQueueOpen ? styles.activeControl : ""}`}
                  onClick={onToggleQueue}
                  aria-label={isQueueOpen ? "Close queue" : "Open queue"}
                  title={isQueueOpen ? "Close queue" : "Open queue"}
                >
                  <IconPlaylist size={18} />
                </button>
              </div>

              <VolumeControl />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
