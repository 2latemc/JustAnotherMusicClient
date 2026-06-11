import appIcon from "../../../assets/img/Logo.png";
import styles from "./AppLoadingScreen.module.css";

const LOADING_LINES = [
  "Some magic things happening",
  "Tuning things up",
  "Finding the right frequency",
  "Getting the music ready",
  "Tuning..",
  "Putting the beat together",
];

interface AppLoadingScreenProps {
  isLeaving: boolean;
}

export function AppLoadingScreen({ isLeaving }: AppLoadingScreenProps) {
  const loadingLine = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];

  return (
    <div
      className={`${styles.screen} ${isLeaving ? styles.leaving : ""}`}
      role="status"
      aria-label="Loading"
      aria-live="polite"
    >
      <div className={styles.ambient} />
      <div className={styles.content}>
        <img className={styles.mark} src={appIcon} alt="" />
        <div className={styles.wordmark}>
          <strong>{loadingLine}</strong>
        </div>
        <div className={styles.progress} aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
