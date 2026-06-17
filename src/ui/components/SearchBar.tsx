import {
  IconArrowLeft,
  IconArrowRight,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import { primaryModifierLabel } from "../platform";
import styles from "./SearchBar.module.css";

interface SearchBarProps {
  onOpen: () => void;
  onOpenSettings: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

export function SearchBar({
  onOpen,
  onOpenSettings,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: SearchBarProps) {
  const showBackButton = canGoBack || canGoForward;

  return (
    <div className={styles.row}>
      {showBackButton && (
        <button
          className={styles.navigationButton}
          type="button"
          onClick={onBack}
          disabled={!canGoBack}
          aria-label="Go back"
          title="Back"
        >
          <IconArrowLeft size={18} aria-hidden="true" />
        </button>
      )}
      {canGoForward && (
        <button
          className={styles.navigationButton}
          type="button"
          onClick={onForward}
          aria-label="Go forward"
          title="Forward"
        >
          <IconArrowRight size={18} aria-hidden="true" />
        </button>
      )}
      <button className={styles.bar} type="button" onClick={onOpen} data-onboarding="search">
        <IconSearch size={17} />
        <span>Search artists, songs, playlists, and albums</span>
        <kbd>{primaryModifierLabel} Space</kbd>
      </button>
      <button
        className={styles.settingsButton}
        type="button"
        onClick={onOpenSettings}
        aria-label="Open settings"
        title="Settings"
      >
        <IconSettings size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
