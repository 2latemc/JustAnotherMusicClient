import { useEffect, useMemo, useState } from "react";
import { IconDisc } from "@tabler/icons-react";
import { getArtworkUrlCandidates } from "../../datasource/youtube/artwork";
import styles from "./TrackArtwork.module.css";

interface TrackArtworkProps {
  artworkUrl?: string;
  className?: string;
  iconSize?: number;
  loading?: "eager" | "lazy";
}

export function TrackArtwork({
  artworkUrl,
  className,
  iconSize = 24,
  loading = "lazy",
}: TrackArtworkProps) {
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
    <span className={`${styles.root} ${className ?? ""}`}>
      {!currentArtworkUrl ? (
        <IconDisc size={iconSize} aria-hidden="true" />
      ) : (
        <img
          src={currentArtworkUrl}
          alt=""
          loading={loading}
          onError={() => setArtworkIndex((index) => index + 1)}
        />
      )}
    </span>
  );
}
