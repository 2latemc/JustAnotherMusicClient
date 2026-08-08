import { useEffect, useRef, useState } from "react";
import { IconDownload, IconLoader2, IconPlayerPause } from "@tabler/icons-react";
import {
  pauseDownloads,
  resumeDownloads,
  useDownloaderState,
} from "../../plugins/official/downloader/downloaderStore";
import { usePluginEnabled } from "../../plugins/pluginHost";
import { DOWNLOADER_PLUGIN_ID } from "../../plugins/official/downloader/manifest";
import styles from "./DownloadsPopover.module.css";

export function DownloadsPopover() {
  const downloader = useDownloaderState();
  const pluginEnabled = usePluginEnabled(DOWNLOADER_PLUGIN_ID);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const activeTrack = downloader.downloadingId
    ? downloader.pending[downloader.downloadingId]
    : null;
  const queuedTracks = downloader.queued
    .map((id) => downloader.pending[id])
    .filter(Boolean)
    .slice(0, 5);
  const hasActivity = Boolean(activeTrack || queuedTracks.length > 0);

  if (!pluginEnabled || !hasActivity) return null;

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={`${styles.button} ${hasActivity ? styles.buttonActive : ""}`}
        aria-label="Downloads"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {downloader.paused ? (
          <IconPlayerPause size={17} aria-hidden="true" />
        ) : hasActivity ? (
          <IconLoader2 className={styles.spinner} size={17} aria-hidden="true" />
        ) : (
          <IconDownload size={17} aria-hidden="true" />
        )}
      </button>

      {open && (
        <section className={styles.panel} aria-label="Download queue">
          <header className={styles.panelHeader}>
            <strong>Downloads</strong>
            {hasActivity && (
              <button
                type="button"
                onClick={() => downloader.paused ? resumeDownloads() : pauseDownloads()}
              >
                {downloader.paused ? "Resume" : "Pause"}
              </button>
            )}
          </header>
          {activeTrack ? (
            <div className={styles.activeDownload}>
              <span>{activeTrack.title}</span>
              <div className={styles.progressTrack}>
                <span style={{ width: `${downloader.progress ?? 8}%` }} />
              </div>
              <small>{downloader.progress !== null ? `${downloader.progress}%` : "Downloading"}</small>
            </div>
          ) : (
            <p className={styles.empty}>No active download.</p>
          )}
          {queuedTracks.length > 0 && (
            <div className={styles.queue}>
              {queuedTracks.map((track) => (
                <span key={track.id}>{track.title}</span>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
