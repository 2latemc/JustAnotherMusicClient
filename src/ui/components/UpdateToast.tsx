import { useEffect } from "react";
import { IconX } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateInfo } from "../../internal/updateChecker";
import { snoozeUpdate } from "../../internal/updateChecker";
import styles from "./UpdateToast.module.css";

const AUTO_DISMISS_MS = 60_000;

interface UpdateToastProps {
  update: UpdateInfo;
  onDismiss: () => void;
}

export function UpdateToast({ update, onDismiss }: UpdateToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      snoozeUpdate(update.version);
      onDismiss();
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss, update.version]);

  const dismiss = () => {
    snoozeUpdate(update.version);
    onDismiss();
  };

  const download = () => {
    snoozeUpdate(update.version);
    onDismiss();
    void openUrl(update.releaseUrl);
  };

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <strong>New version available</strong>
      <button className={styles.downloadButton} type="button" onClick={download}>
        Download
      </button>
      <button
        className={styles.closeButton}
        type="button"
        onClick={dismiss}
        aria-label="Close update notification"
        title="Close"
      >
        <IconX size={17} />
      </button>
    </div>
  );
}
