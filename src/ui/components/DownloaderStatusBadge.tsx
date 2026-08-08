import {
  IconCheck,
  IconDownload,
  IconLoader2,
  IconPlayerPause,
  IconX,
} from "@tabler/icons-react";
import type { Track } from "../../datasource/types";
import {
  getDownloadStatus,
  queueDownload,
  useDownloaderState,
} from "../../plugins/official/downloader/downloaderStore";
import { usePluginEnabled } from "../../plugins/pluginHost";
import { DOWNLOADER_PLUGIN_ID } from "../../plugins/official/downloader/manifest";
import styles from "./DownloaderStatusBadge.module.css";

export function DownloaderStatusBadge({ track }: { track: Track }) {
  useDownloaderState();
  const pluginEnabled = usePluginEnabled(DOWNLOADER_PLUGIN_ID);
  if (!pluginEnabled || track.source === "local") return null;

  const status = getDownloadStatus(track.id);
  if (status === "absent") {
    return (
      <span
        role="button"
        tabIndex={0}
        className={`${styles.badge} ${styles.hiddenBadge}`}
        aria-label={`Download ${track.title}`}
        onClick={(event) => {
          event.stopPropagation();
          queueDownload(track);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          queueDownload(track);
        }}
      >
        <IconDownload size={16} aria-hidden="true" />
      </span>
    );
  }

  const icon = status === "ready"
    ? <IconCheck size={16} aria-hidden="true" />
    : status === "failed"
      ? <IconX size={16} aria-hidden="true" />
      : status === "paused"
        ? <IconPlayerPause size={16} aria-hidden="true" />
        : <IconLoader2 className={styles.spinner} size={16} aria-hidden="true" />;

  return (
    <span
      className={`${styles.badge} ${styles[status]}`}
      aria-label={`Download status: ${status}`}
      title={`Download status: ${status}`}
    >
      {icon}
    </span>
  );
}
