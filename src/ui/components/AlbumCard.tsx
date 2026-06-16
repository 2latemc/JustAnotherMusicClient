import { type MouseEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { IconMusic, IconPlayerPlay } from "@tabler/icons-react";
import { getArtworkUrlCandidates } from "../../datasource/youtube/artwork";
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
  const artworkCandidates = useMemo(
    () => getArtworkUrlCandidates(artworkUrl),
    [artworkUrl],
  );
  const [artworkIndex, setArtworkIndex] = useState(0);
  const currentArtworkUrl = artworkCandidates[artworkIndex];

  useEffect(() => {
    setArtworkIndex(0);
  }, [artworkUrl]);

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
        {currentArtworkUrl ? (
          <img
            className={styles.artwork}
            src={currentArtworkUrl}
            alt=""
            loading="lazy"
            onError={() => setArtworkIndex((index) => index + 1)}
          />
        ) : (
          <IconMusic className={styles.artworkFallback} size={48} aria-hidden="true" />
        )}
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
