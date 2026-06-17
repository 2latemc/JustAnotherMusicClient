import { useEffect, useMemo, useState } from "react";
import { IconDisc, IconMusic, IconPlaylist, IconUser } from "@tabler/icons-react";
import { getArtworkUrlCandidates } from "../../datasource/youtube/artwork";
import { tauriFetch } from "../../datasource/youtube/tauriFetch";
import styles from "./TrackArtwork.module.css";

interface TrackArtworkProps {
  artworkUrl?: string;
  className?: string;
  iconSize?: number;
  loading?: "eager" | "lazy";
  variant?: "track" | "album" | "artist" | "playlist";
}

export function TrackArtwork({
  artworkUrl,
  className,
  iconSize = 24,
  loading = "lazy",
  variant = "track",
}: TrackArtworkProps) {
  const artworkCandidates = useMemo(
    () => getArtworkUrlCandidates(artworkUrl),
    [artworkUrl],
  );
  const [artworkIndex, setArtworkIndex] = useState(0);
  const [proxiedArtworkUrl, setProxiedArtworkUrl] = useState<string | null>(null);
  const [loadedArtworkUrl, setLoadedArtworkUrl] = useState<string | null>(null);
  const currentArtworkUrl = artworkCandidates[artworkIndex] ?? proxiedArtworkUrl;
  const isArtworkLoaded = loadedArtworkUrl === currentArtworkUrl;
  const FallbackIcon =
    variant === "artist"
      ? IconUser
      : variant === "album"
        ? IconMusic
        : variant === "playlist"
          ? IconPlaylist
          : IconDisc;

  useEffect(() => {
    setArtworkIndex(0);
    setProxiedArtworkUrl(null);
    setLoadedArtworkUrl(null);
  }, [artworkUrl]);

  useEffect(() => {
    if (!artworkUrl || artworkIndex < artworkCandidates.length || proxiedArtworkUrl) return;

    let objectUrl: string | null = null;
    let active = true;

    void tauriFetch(artworkUrl, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Artwork request failed with HTTP ${response.status}.`);
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setProxiedArtworkUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {
        if (active) setProxiedArtworkUrl(null);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artworkCandidates.length, artworkIndex, artworkUrl, proxiedArtworkUrl]);

  return (
    <span className={`${styles.root} ${className ?? ""}`}>
      <FallbackIcon
        className={`${styles.fallbackIcon} ${isArtworkLoaded ? styles.fallbackIconHidden : ""}`}
        size={iconSize}
        aria-hidden="true"
      />
      {currentArtworkUrl && (
        <img
          className={isArtworkLoaded ? styles.imageLoaded : ""}
          src={currentArtworkUrl}
          alt=""
          loading={loading}
          onLoad={() => setLoadedArtworkUrl(currentArtworkUrl)}
          onError={() => {
            setLoadedArtworkUrl(null);
            setArtworkIndex((index) => index + 1);
          }}
        />
      )}
    </span>
  );
}
