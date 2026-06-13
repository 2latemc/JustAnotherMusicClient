import { IconChevronRight, IconPlaylist, IconTrash } from "@tabler/icons-react";
import { usePlayerSession, playerController } from "../../../player/playerStore";
import styles from "./QueuePanel.module.css";

interface QueuePanelProps {
  onClose: () => void;
}

export function QueuePanel({ onClose }: QueuePanelProps) {
  const playerSession = usePlayerSession();
  const queue = playerSession?.queue ?? [];
  const queueIndex = playerSession?.queueIndex ?? -1;
  const manualQueueLength = playerSession?.manualQueueLength ?? 0;
  const upcoming = queue.slice(Math.max(queueIndex + 1, 0));
  const manualQueue = upcoming.slice(0, manualQueueLength);
  const autoQueue = upcoming.slice(manualQueueLength);

  const handleRemove = (offset: number) => {
    const index = Math.max(queueIndex + 1, 0) + offset;
    playerController.removeFromQueueAt(index);
  };

  return (
    <aside className={styles.queuePanel} aria-label="Queue panel">
      <div className={styles.header}>
        <h2 className={styles.title}>QUEUE</h2>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="Close queue panel"
        >
          <IconChevronRight size={18} />
        </button>
      </div>

      {upcoming.length === 0 ? (
        <p className={styles.emptyMessage}>No queued songs.</p>
      ) : (
        <>
          {manualQueue.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <IconPlaylist size={16} />
                <span>Manually added</span>
              </div>
              <div className={styles.trackList}>
                {manualQueue.map((track, index) => (
                  <div key={track.id} className={styles.trackItem}>
                    <div className={styles.trackDetails}>
                      <span className={styles.trackTitle}>{track.title}</span>
                      <span className={styles.trackArtist}>{track.artist}</span>
                    </div>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        handleRemove(index);
                      }}
                      aria-label={`Remove ${track.title} from queue`}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {autoQueue.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <IconPlaylist size={16} />
                <span>Auto queue</span>
              </div>
              <div className={styles.trackList}>
                {autoQueue.map((track, index) => (
                  <div key={track.id} className={styles.trackItem}>
                    <div className={styles.trackDetails}>
                      <span className={styles.trackTitle}>{track.title}</span>
                      <span className={styles.trackArtist}>{track.artist}</span>
                    </div>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        handleRemove(manualQueueLength + index);
                      }}
                      aria-label={`Remove ${track.title} from queue`}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
