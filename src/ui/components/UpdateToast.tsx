import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateInfo, UpdateInstallProgress } from "../../internal/updateChecker";
import { installUpdate, snoozeUpdate } from "../../internal/updateChecker";
import styles from "./UpdateToast.module.css";

const AUTO_DISMISS_MS = 60_000;

interface UpdateToastProps {
  update: UpdateInfo;
  onDismiss: () => void;
}

export function UpdateToast({ update, onDismiss }: UpdateToastProps) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const releaseLabel = update.canInstall ? "GitHub" : "Download";
  const releaseButtonClassName = `${styles.changesButton} ${
    update.canInstall ? styles.secondaryButton : styles.primaryButton
  }`;

  useEffect(() => {
    if (installing) return;
    const timer = window.setTimeout(() => {
      snoozeUpdate(update.version);
      onDismiss();
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [installing, onDismiss, update.version]);

  const dismiss = () => {
    if (installing) return;
    snoozeUpdate(update.version);
    onDismiss();
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installUpdate(update, setProgress);
    } catch {
      setError("Installation failed. You can still open the release on GitHub.");
      setInstalling(false);
    }
  };

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <div className={styles.message}>
        <strong>Version {update.version} is available</strong>
        {installing && (
          <span>
            {progress?.percent !== undefined
              ? `Downloading ${progress.percent}%`
              : "Preparing update..."}
          </span>
        )}
        {error && <span className={styles.error}>{error}</span>}
      </div>
      <div className={styles.actions}>
        {update.canInstall && (
          <button
            className={`${styles.installButton} ${styles.primaryButton}`}
            type="button"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? "Installing..." : "Install"}
          </button>
        )}
        <a
          className={releaseButtonClassName}
          href={update.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open version ${update.version} release on GitHub`}
          onClick={(e) => {
            e.preventDefault();
            void openUrl(update.releaseUrl);
          }}
        >
          {releaseLabel}
        </a>
        <button
          className={styles.closeButton}
          type="button"
          disabled={installing}
          onClick={dismiss}
          aria-label="Close update notification"
          title="Close"
        >
          <IconX size={16} />
        </button>
      </div>
    </div>
  );
}
