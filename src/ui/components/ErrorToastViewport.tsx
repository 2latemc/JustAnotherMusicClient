import { IconAlertTriangle, IconBrandGithub, IconClipboard, IconX } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  appErrorManager,
  GITHUB_NEW_ISSUE_URL,
  type AppErrorNotification,
  useAppErrorNotifications,
} from "../errors/errorManager";
import styles from "./ErrorToastViewport.module.css";

const MAX_VISIBLE_MESSAGE_LENGTH = 150;

interface ErrorToastViewportProps {
  isShifted?: boolean;
}

function getVisibleMessage(message: string): string {
  const compactMessage = message.replace(/\s+/g, " ").trim();
  if (compactMessage.length <= MAX_VISIBLE_MESSAGE_LENGTH) return compactMessage;
  return `${compactMessage.slice(0, MAX_VISIBLE_MESSAGE_LENGTH - 3)}...`;
}

async function copyErrorMessage(notification: AppErrorNotification): Promise<void> {
  await navigator.clipboard.writeText(notification.message);
}

function ErrorToast({ notification }: { notification: AppErrorNotification }) {
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <IconAlertTriangle className={styles.icon} size={20} aria-hidden="true" />
      <div className={styles.message}>
        <strong>{notification.title}</strong>
        <span>{getVisibleMessage(notification.message)}</span>
      </div>
      <div className={styles.actions}>
        <button
          className={styles.iconButton}
          type="button"
          onClick={() => void copyErrorMessage(notification)}
          aria-label="Copy error message"
          title="Copy error message"
        >
          <IconClipboard size={16} />
        </button>
        <button
          className={styles.iconButton}
          type="button"
          onClick={() => void openUrl(GITHUB_NEW_ISSUE_URL)}
          aria-label="Submit issue on GitHub"
          title="Submit issue on GitHub"
        >
          <IconBrandGithub size={16} />
        </button>
        <button
          className={styles.closeButton}
          type="button"
          onClick={() => appErrorManager.dismiss(notification.id)}
          aria-label="Close error notification"
          title="Close"
        >
          <IconX size={16} />
        </button>
      </div>
    </div>
  );
}

export function ErrorToastViewport({ isShifted = false }: ErrorToastViewportProps) {
  const notifications = useAppErrorNotifications();
  if (notifications.length === 0) return null;

  return (
    <div className={`${styles.viewport} ${isShifted ? styles.shifted : ""}`}>
      {notifications.map((notification) => (
        <ErrorToast notification={notification} key={notification.id} />
      ))}
    </div>
  );
}
