import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconArrowsShuffle,
  IconCheck,
  IconCopy,
  IconLoader2,
  IconPlayerPlay,
  IconUser,
  IconUserPlus,
} from "@tabler/icons-react";
import type { Album, Artist, ArtistPage, Playlist, Track } from "../../datasource/types";
import { getArtworkUrlCandidates } from "../../datasource/youtube/artwork";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { shuffleTracks } from "../../player/shuffleTracks";
import { AlbumCard } from "../components/AlbumCard";
import { ArtistLinks } from "../components/ArtistLinks";
import { TrackArtwork } from "../components/TrackArtwork";
import { usePlaylistContextMenu } from "../components/PlaylistContextMenu";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import styles from "./ArtistView.module.css";

type ReleaseFilter = "all" | "album" | "single" | "ep";

function compactViews(track: Track): string {
  if (track.viewCount) {
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(track.viewCount);
  }
  return track.viewCountText
    ? track.viewCountText.replace(/\s*\b(?:views?|plays?)\b\.?/i, "").trim()
    : "";
}

function getArtistUrl(artist: Artist): string {
  if (artist.id.startsWith("UC")) {
    return `https://music.youtube.com/channel/${encodeURIComponent(artist.id)}`;
  }
  if (artist.id) {
    return `https://music.youtube.com/browse/${encodeURIComponent(artist.id)}`;
  }
  return `https://music.youtube.com/search?q=${encodeURIComponent(artist.name)}`;
}

export function ArtistView({
  artist,
  playerController,
  libraryController,
  onOpenAlbum,
  onOpenPlaylist,
}: {
  artist?: Artist;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
  onOpenAlbum: (album: Album) => void;
  onOpenPlaylist: (playlist: Playlist) => void;
}) {
  const { openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu, openAlbumMenu } = usePlaylistContextMenu();
  const [page, setPage] = useState<ArtistPage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReleaseFilter>("all");
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!artist) return;
    let active = true;
    setPage(null);
    setIsLoading(true);
    setError(null);
    setFilter("all");
    void libraryController.getArtist(artist.id, (updated) => {
      if (active) setPage(updated);
    })
      .then((result) => {
        if (active) setPage(result);
      })
      .catch(() => {
        if (active) setError("Unable to load this artist.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [artist, libraryController]);

  const releaseTypes = useMemo(
    () => new Set(page?.releases.map((release) => release.releaseType) ?? []),
    [page?.releases],
  );
  const releaseFilters = useMemo(
    () => (["all", "album", "single", "ep"] as const)
      .filter((type) => type === "all" || releaseTypes.has(type)),
    [releaseTypes],
  );
  const activeFilterIndex = Math.max(0, releaseFilters.indexOf(filter));
  const visibleReleases = page?.releases.filter(
    (release) => filter === "all" || release.releaseType === filter,
  ) ?? [];

  const displayedArtist = page?.artist ?? artist;
  const artistArtworkCandidates = useMemo(
    () => getArtworkUrlCandidates(displayedArtist?.artworkUrl),
    [displayedArtist?.artworkUrl],
  );
  const [artistArtworkIndex, setArtistArtworkIndex] = useState(0);
  const currentArtistArtworkUrl = artistArtworkCandidates[artistArtworkIndex];
  const popularSongs = page?.popularSongs.slice(0, 6) ?? [];

  useEffect(() => {
    setArtistArtworkIndex(0);
    setIsSubscribed(page?.subscribed ?? false);
  }, [displayedArtist?.artworkUrl, displayedArtist?.id, page?.subscribed]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  if (!artist || !displayedArtist) return null;

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  };

  const playShuffled = () => {
    const shuffled = shuffleTracks(page?.allSongs ?? []);
    if (shuffled[0]) {
      void playerController.playTrackById(shuffled[0].id, shuffled);
    }
  };

  const toggleArtistSubscription = async () => {
    if (isSubscribing) return;
    const nextSubscribed = !isSubscribed;
    setIsSubscribing(true);
    try {
      await libraryController.setArtistSubscribed(displayedArtist, nextSubscribed);
      setIsSubscribed(nextSubscribed);
    } catch (subscribeError) {
      showToast(
        subscribeError instanceof Error
          ? subscribeError.message
          : "Unable to update this subscription.",
      );
    } finally {
      setIsSubscribing(false);
    }
  };

  const copyArtistUrl = async () => {
    try {
      await navigator.clipboard.writeText(getArtistUrl(displayedArtist));
      showToast("Url copied to clipboard");
    } catch {
      showToast("Unable to copy the link.");
    }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.portrait}>
          {currentArtistArtworkUrl ? (
            <img
              key={currentArtistArtworkUrl}
              src={currentArtistArtworkUrl}
              alt=""
              onError={() => {
                setArtistArtworkIndex((prev) => prev + 1);
                // If all candidates failed, try the raw URL one final time
                // (the raw URL may work without size parameters).
                if (artistArtworkIndex >= artistArtworkCandidates.length - 1) {
                  setArtistArtworkIndex(0);
                }
              }}
            />
          ) : (
            <IconUser size={84} stroke={1.4} />
          )}
        </div>
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>Artist</span>
          <h1>
            <button
              type="button"
              className={styles.artistTitleButton}
              onClick={() => void copyArtistUrl()}
              aria-label={`Copy ${displayedArtist.name} URL`}
            >
              <span>{displayedArtist.name}</span>
              <IconCopy className={styles.artistTitleCopyIcon} size={24} aria-hidden="true" />
            </button>
          </h1>
          {displayedArtist.subscriberCount && (
            <p>{displayedArtist.subscriberCount}</p>
          )}
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.subscribeButton}
            type="button"
            disabled={isLoading || Boolean(error) || isSubscribing}
            onClick={() => void toggleArtistSubscription()}
          >
            {isSubscribing ? (
              <IconLoader2 className={styles.buttonLoadingIcon} size={18} />
            ) : isSubscribed ? (
              <IconCheck size={18} />
            ) : (
              <IconUserPlus size={18} />
            )}
            <span>
              {isSubscribing
                ? isSubscribed ? "Unsubscribing..." : "Subscribing..."
                : isSubscribed ? "Subscribed" : "Subscribe"}
            </span>
          </button>
          <button
            className={styles.shuffleButton}
            type="button"
            disabled={isLoading || Boolean(error) || !page?.allSongs.length}
            onClick={playShuffled}
          >
            <IconArrowsShuffle size={18} />
            <span>Shuffle</span>
          </button>
        </div>
      </header>

      {isLoading && <p className={styles.message}>Loading artist...</p>}
      {error && <p className={styles.message}>{error}</p>}

      {!isLoading && !error && page && (
        <>
          {popularSongs.length > 0 && (
            <section className={styles.section}>
              <h2>Popular</h2>
              <div className={styles.trackList}>
                {popularSongs.map((track, index) => (
                  <button
                    key={track.id}
                    type="button"
                    className={styles.track}
                    onContextMenu={(event) => openTrackMenu(event, track)}
                    onClick={() => void playerController.playTrackById(
                      track.id,
                      page.allSongs,
                    )}
                  >
                    <span className={styles.index}>{index + 1}</span>
                    <TrackArtwork
                      className={styles.trackArtwork}
                      artworkUrl={track.artworkUrl}
                      iconSize={22}
                    />
                    <span className={styles.trackText}>
                      <strong>{track.title}</strong>
                      <ArtistLinks artists={track.artists} fallback={track.artist} suppressArtistId={displayedArtist.id} />
                    </span>
                    <span className={styles.views}>{compactViews(track)}</span>
                    <IconPlayerPlay size={18} />
                  </button>
                ))}
              </div>
            </section>
          )}

          {page.releases.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>Releases</h2>
                <div
                  className={styles.filters}
                  role="group"
                  aria-label="Release type"
                  style={{
                    "--active-filter-offset": `${activeFilterIndex * 100}%`,
                    "--filter-count": releaseFilters.length,
                  } as CSSProperties}
                >
                  {releaseFilters
                    .map((type) => (
                      <button
                        key={type}
                        type="button"
                        className={filter === type ? styles.activeFilter : ""}
                        aria-pressed={filter === type}
                        onClick={() => setFilter(type)}
                      >
                        {type === "all"
                          ? "All"
                          : type === "ep"
                            ? "EPs"
                            : `${type[0].toUpperCase()}${type.slice(1)}s`}
                      </button>
                    ))}
                </div>
              </div>
              <div key={filter} className={`${styles.cardGrid} ${styles.releaseGrid}`}>
                {visibleReleases.map((release) => {
                  const hasLinkedArtists = Boolean(release.artists?.length);
                  return (
                    <div key={release.id} className={styles.releaseCard}>
                      <AlbumCard
                        artworkUrl={release.artworkUrl}
                        title={release.title}
                        subtitle={hasLinkedArtists ? undefined : release.artist}
                        subtitleContent={hasLinkedArtists
                          ? (
                              <ArtistLinks
                                artists={release.artists}
                                fallback={release.artist}
                                suppressArtistId={displayedArtist.id}
                              />
                            )
                          : undefined}
                        onClick={() => onOpenAlbum(release)}
                        onContextMenu={(event) => openAlbumMenu(event, release)}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {page.playlists.length > 0 && (
            <section className={styles.section}>
              <h2>Playlists</h2>
              <div className={styles.cardGrid}>
                {page.playlists.map((playlist) => (
                  <AlbumCard
                    key={playlist.id}
                    artworkUrl={playlist.artworkUrl}
                    title={playlist.title}
                    subtitle={playlist.owner}
                    onClick={() => onOpenPlaylist(playlist)}
                    onContextMenu={(event) => openPlaylistMenu(event, playlist)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {toast && createPortal(
        <div className={styles.toast} role="status">
          {toast === "Url copied to clipboard" && (
            <IconCheck size={18} aria-hidden="true" />
          )}
          <span>{toast}</span>
        </div>,
        document.body,
      )}
    </div>
  );
}
