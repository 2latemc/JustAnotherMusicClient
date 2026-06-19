
import styles from './ExpandedPlayerBar.module.css';

interface ExpandedPlayerBarProps {
  isOpen: boolean;
  onClose?: () => void; // Optional: callback to close the player
}

export default function ExpandedPlayerBar({ isOpen, onClose }: ExpandedPlayerBarProps) {
  return (
    /* 1. The outer floating frame that grows from 70px to 100vh */
    <div className={`${styles.expandedPlayerBarFrame} ${isOpen ? styles.parentOpen : ''}`}>
      
      {/* 2. Mini Player Content (Visible only when closed) */}
      {!isOpen && (
        <div className={styles.miniPlayerContent}>
          <span>🎵 Now Playing: Song Title</span>
          <span className={styles.tapHint}>Tap to expand</span>
        </div>
      )}

      {/* 3. The Sliding Expanded Panel */}
      <div className={`${styles.slideContainer} ${isOpen ? styles.slideActive : ''}`}>
        
        {/* Close Button */}
        {onClose && (
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        )}

        {/* Full Player Content */}
        <div className={styles.expandedContent}>
          <h2>Now Playing</h2>
          <div className={styles.albumArt}></div>
          <p className={styles.songTitle}>Song Title</p>
          <p className={styles.artistName}>Artist Name</p>
          {/* Add your controls and progress bars here */}
        </div>

      </div>
    </div>
  );
}