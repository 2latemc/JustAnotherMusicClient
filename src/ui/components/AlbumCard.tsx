import { type MouseEvent, type ReactNode } from "react";
import { IconPlayerPlay } from "@tabler/icons-react";
import { TrackArtwork } from "./TrackArtwork";
import styles from "./AlbumCard.module.css";

interface AlbumCardProps {
  color?: string;
  artworkUrl?: string;
  title?: string;
  subtitle?: string;
  subtitleContent?: ReactNode;
  onClick?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function AlbumCard({
  color = "#333333",
  artworkUrl,
  title,
  subtitle,
  subtitleContent,
  onClick,
  onContextMenu,
}: AlbumCardProps) {
  return (
    <div
      className={styles.card}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onClick?.();
      }}
      role="button"
      tabIndex={0}
    >
      <div className={styles.cover} style={{ backgroundColor: color }}>
        <TrackArtwork
          className={styles.artwork}
          artworkUrl={artworkUrl}
          iconSize={48}
          variant="album"
        />
        <div className={styles.playOverlay}>
          <IconPlayerPlay size={32} className={styles.playIcon} />
        </div>
      </div>
      {title && <span className={styles.title}>{title}</span>}
      {(subtitleContent || subtitle) && (
        <span className={styles.subtitle}>{subtitleContent ?? subtitle}</span>
      )}
    </div>
  );
}
