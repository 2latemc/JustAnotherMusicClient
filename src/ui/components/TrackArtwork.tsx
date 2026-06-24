import { useEffect, useMemo, useRef, useState } from "react";
import { IconDisc, IconMusic, IconPlaylist, IconUser } from "@tabler/icons-react";
import { getArtworkUrlCandidates } from "../../datasource/youtube/artwork";
import { tauriFetch } from "../../datasource/youtube/tauriFetch";
import styles from "./TrackArtwork.module.css";

const ARTWORK_RETRY_DELAYS_MS = [500, 1500];

function getRetriedArtworkUrl(url: string, retryCount: number): string {
  if (retryCount === 0 || url.startsWith("blob:")) return url;

  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = urlWithoutHash.includes("?") ? "&" : "?";
  return `${urlWithoutHash}${separator}artworkRetry=${retryCount}${hash}`;
}

interface TrackArtworkProps {
  artworkUrl?: string;
  className?: string;
  iconSize?: number;
  loading?: "eager" | "lazy";
  retryOnError?: boolean;
  variant?: "track" | "album" | "artist" | "playlist";
}

export function TrackArtwork({
  artworkUrl,
  className,
  iconSize = 24,
  loading = "lazy",
  retryOnError = false,
  variant = "track",
}: TrackArtworkProps) {
  const artworkCandidates = useMemo(
    () => getArtworkUrlCandidates(artworkUrl),
    [artworkUrl],
  );
  const [artworkIndex, setArtworkIndex] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [proxiedArtworkUrl, setProxiedArtworkUrl] = useState<string | null>(null);
  const [loadedArtworkUrl, setLoadedArtworkUrl] = useState<string | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const baseArtworkUrl = artworkCandidates[artworkIndex] ?? proxiedArtworkUrl;
  const currentArtworkUrl = baseArtworkUrl
    ? getRetriedArtworkUrl(baseArtworkUrl, retryCount)
    : undefined;
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
    setRetryCount(0);
    setProxiedArtworkUrl(null);
    setLoadedArtworkUrl(null);
  }, [artworkUrl]);

  useEffect(() => () => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
    }
  }, []);

  useEffect(() => {
    setRetryCount(0);
    setLoadedArtworkUrl(null);
  }, [baseArtworkUrl]);

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
            if (retryOnError && retryCount < ARTWORK_RETRY_DELAYS_MS.length) {
              if (retryTimerRef.current !== null) {
                window.clearTimeout(retryTimerRef.current);
              }
              retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                setRetryCount((count) =>
                  count === retryCount ? count + 1 : count,
                );
              }, ARTWORK_RETRY_DELAYS_MS[retryCount]);
              return;
            }
            setRetryCount(0);
            setArtworkIndex((index) => index + 1);
          }}
        />
      )}
    </span>
  );
}
