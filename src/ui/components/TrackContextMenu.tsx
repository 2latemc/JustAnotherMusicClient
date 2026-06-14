import {
  createContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconCheck,
  IconHeart,
  IconHeartFilled,
  IconLink,
  IconListDetails,
  IconLoader2,
  IconMusicPlus,
  IconPlayerTrackNext,
  IconPlaylist,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import type { Playlist, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import { logInternalError } from "../../internal/logging";
import {
  playerController,
  useLibraryState,
  usePlayerState,
} from "../../player/playerStore";
import { TrackArtwork } from "./TrackArtwork";
import styles from "./TrackContextMenu.module.css";

interface MenuPosition {
  x: number;
  y: number;
}

interface TrackContextMenuValue {
  openTrackMenu: (
    event: ReactMouseEvent,
    track: Track,
    context?: {
      playlist?: Playlist;
      onRemove?: (track: Track) => void;
    },
  ) => void;
  toggleTrackLike: (track: Track) => Promise<void>;
}

interface TrackContextMenuProviderProps {
  children: ReactNode;
  libraryController: LibraryController;
}

const TrackContextMenuContext = createContext<TrackContextMenuValue | null>(null);

export function useTrackContextMenu(): TrackContextMenuValue {
  const value = useContext(TrackContextMenuContext);
  if (!value) {
    throw new Error("useTrackContextMenu must be used within TrackContextMenuProvider.");
  }
  return value;
}

export function TrackContextMenuProvider({
  children,
  libraryController,
}: TrackContextMenuProviderProps) {
  const libraryState = useLibraryState();
  const playerState = usePlayerState();
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const playlistRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const toastTimerRef = useRef<number | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [menuContext, setMenuContext] = useState<{
    playlist?: Playlist;
    onRemove?: (track: Track) => void;
  } | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPlaylistIndex, setSelectedPlaylistIndex] = useState<number | null>(null);
  const [addingPlaylistId, setAddingPlaylistId] = useState<string | null>(null);
  const [isRemovingTrack, setIsRemovingTrack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const playlists = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const items = libraryState.library?.playlists ?? [];
    if (!normalizedQuery) return items;
    return items.filter((playlist) =>
      playlist.title.toLocaleLowerCase().includes(normalizedQuery)
    );
  }, [libraryState.library?.playlists, query]);

  useEffect(() => {
    if (!menuPosition) return;
    const closeMenu = () => setMenuPosition(null);
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [menuPosition]);

  useLayoutEffect(() => {
    if (!menuPosition) return;

    const keepMenuInViewport = () => {
      const menu = menuRef.current;
      if (!menu) return;

      const viewportMargin = 8;
      const bounds = menu.getBoundingClientRect();
      const x = Math.max(
        viewportMargin,
        Math.min(menuPosition.x, window.innerWidth - bounds.width - viewportMargin),
      );
      const y = Math.max(
        viewportMargin,
        Math.min(menuPosition.y, window.innerHeight - bounds.height - viewportMargin),
      );

      if (x !== menuPosition.x || y !== menuPosition.y) {
        setMenuPosition({ x, y });
      }
    };

    keepMenuInViewport();
    window.addEventListener("resize", keepMenuInViewport);
    return () => window.removeEventListener("resize", keepMenuInViewport);
  }, [menuContext, menuPosition, track]);

  useEffect(() => {
    if (isPickerOpen) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!isPickerOpen && !menuPosition)) return;
      event.preventDefault();
      setMenuPosition(null);
      if (!addingPlaylistId) setIsPickerOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addingPlaylistId, isPickerOpen, menuPosition]);

  useEffect(() => {
    if (selectedPlaylistIndex === null) return;
    playlistRefs.current[selectedPlaylistIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedPlaylistIndex]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const ctrlOnly = event.ctrlKey
        && !event.altKey
        && !event.metaKey
        && !event.shiftKey;
      if (!ctrlOnly || event.code !== "KeyS") return;

      event.preventDefault();
      if (!playerState.currentTrack || addingPlaylistId) return;

      setTrack(playerState.currentTrack);
      setMenuPosition(null);
      setError(null);
      setQuery("");
      setSelectedPlaylistIndex(null);
      setIsPickerOpen(true);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [addingPlaylistId, playerState.currentTrack]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const openTrackMenu = (
    event: ReactMouseEvent,
    selectedTrack: Track,
    context?: { playlist?: Playlist; onRemove?: (track: Track) => void },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setTrack(selectedTrack);
    setMenuContext(context ?? null);
    setIsPickerOpen(false);
    setError(null);
    setQuery("");
    setSelectedPlaylistIndex(null);
    setMenuPosition({
      x: event.clientX,
      y: event.clientY,
    });
  };

  const showToast = (message: string, duration = 3000) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), duration);
  };

  const showPersistentToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  };

  const addToQueue = () => {
    if (!track) return;
    playerController.addToQueue(track);
    setMenuPosition(null);
    showToast(`Added "${track.title}" to queue`);
  };

  const playNext = () => {
    if (!track) return;
    playerController.playNext(track);
    setMenuPosition(null);
    showToast(`"${track.title}" will play next`);
  };

  const copyLink = async () => {
    if (!track) return;
    const selectedTrack = track;
    setMenuPosition(null);
    try {
      await navigator.clipboard.writeText(
        `https://music.youtube.com/watch?v=${encodeURIComponent(selectedTrack.id)}`,
      );
      showToast("Link copied");
    } catch {
      showToast("Unable to copy the link.", 4000);
    }
  };

  const openPicker = () => {
    setMenuPosition(null);
    setError(null);
    setQuery("");
    setSelectedPlaylistIndex(null);
    setIsPickerOpen(true);
  };

  const removeFromPlaylist = async () => {
    if (!track || !menuContext?.playlist || addingPlaylistId || isRemovingTrack) return;

    const selectedTrack = track;
    const playlist = menuContext.playlist;

    setIsRemovingTrack(true);
    setError(null);
    setMenuPosition(null);
    showPersistentToast("Removing...");

    try {
      if (playlist.kind === "liked-songs" || playlist.id === "LM") {
        await libraryController.setTrackLiked(selectedTrack, false);
      } else {
        await libraryController.removeTrackFromPlaylist(selectedTrack, playlist);
      }
      menuContext.onRemove?.(selectedTrack);
      showToast(
        playlist.kind === "liked-songs" || playlist.id === "LM"
          ? "Removed from Liked Songs"
          : `Removed from ${playlist.title}`,
      );
    } catch (removeError) {
      logInternalError("TrackContextMenu.removeFromPlaylist failed", removeError, {
        trackId: selectedTrack.id,
        playlistId: playlist.id,
        playlistTitle: playlist.title,
      });
      showToast(
        removeError instanceof Error ? removeError.message : "Unable to remove this song.",
        4000,
      );
    } finally {
      setIsRemovingTrack(false);
    }
  };

  const handlePickerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (addingPlaylistId || playlists.length === 0) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelectedPlaylistIndex((current) => {
        if (current === null) return direction === 1 ? 0 : playlists.length - 1;
        return (current + direction + playlists.length) % playlists.length;
      });
      return;
    }

    if (event.key === "Enter" && selectedPlaylistIndex !== null) {
      event.preventDefault();
      const playlist = playlists[selectedPlaylistIndex];
      if (playlist) void addToPlaylist(playlist);
    }
  };

  const addToPlaylist = async (playlist: Playlist) => {
    if (!track || addingPlaylistId) return;
    const selectedTrack = track;
    setAddingPlaylistId(playlist.id);
    setError(null);
    setIsPickerOpen(false);
    showPersistentToast("Adding...");
    try {
      const result = await libraryController.addTrackToPlaylist(selectedTrack, playlist);
      showToast(
        result === "already-present"
          ? "Already in playlist"
          : `Added to ${playlist.title}`,
      );
    } catch (addError) {
      showToast(
        addError instanceof Error ? addError.message : "Unable to add this song.",
        4000,
      );
    } finally {
      setAddingPlaylistId(null);
    }
  };

  const toggleTrackLike = async (selectedTrack: Track) => {
    if (libraryState.status === "signed-out" || !libraryState.library) {
      showToast("Sign in to like");
      return;
    }
    if (libraryState.pendingLikeTrackIds.has(selectedTrack.id)) return;

    const shouldLike = !libraryController.isTrackLiked(selectedTrack.id);
    showPersistentToast(shouldLike ? "Liking..." : "Removing like...");
    try {
      await libraryController.setTrackLiked(selectedTrack, shouldLike);
      showToast(shouldLike ? "Added to Liked Songs" : "Removed from Liked Songs");
    } catch (likeError) {
      showToast(
        likeError instanceof Error ? likeError.message : "Unable to update this like.",
        4000,
      );
    }
  };

  const selectedTrackIsLiked = track
    ? libraryState.library?.likedSongs.some((item) => item.id === track.id) ?? false
    : false;
  const isLikeMutationPending = track
    ? libraryState.pendingLikeTrackIds.has(track.id)
    : false;

  return (
    <TrackContextMenuContext.Provider value={{ openTrackMenu, toggleTrackLike }}>
      {children}

      {menuPosition && track && (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          style={{ left: menuPosition.x, top: menuPosition.y }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={playNext}>
            <IconPlayerTrackNext size={18} aria-hidden="true" />
            <span className={styles.menuLabel}>Play next</span>
          </button>
          <button type="button" role="menuitem" onClick={addToQueue}>
            <IconListDetails size={18} aria-hidden="true" />
            <span className={styles.menuLabel}>Add to queue</span>
          </button>
          <button type="button" role="menuitem" onClick={openPicker}>
            <IconMusicPlus size={18} aria-hidden="true" />
            <span className={styles.menuLabel}>Add to playlist</span>
            <kbd>Ctrl S</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (!track) return;
              setMenuPosition(null);
              void toggleTrackLike(track);
            }}
          >
            {selectedTrackIsLiked ? (
              <IconHeartFilled size={18} aria-hidden="true" />
            ) : (
              <IconHeart size={18} aria-hidden="true" />
            )}
            <span className={styles.menuLabel}>
              {selectedTrackIsLiked ? "Remove like" : "Like song"}
            </span>
          </button>
          <button type="button" role="menuitem" onClick={() => void copyLink()}>
            <IconLink size={18} aria-hidden="true" />
            <span className={styles.menuLabel}>Copy link</span>
          </button>
          {menuContext?.playlist
            && menuContext.playlist.kind !== "liked-songs"
            && menuContext.playlist.id !== "LM" && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void removeFromPlaylist()}
              disabled={Boolean(addingPlaylistId || isRemovingTrack)}
            >
              <IconTrash size={18} aria-hidden="true" />
              <span className={styles.menuLabel}>Remove from playlist</span>
            </button>
          )}
        </div>
      )}

      {isPickerOpen && track && (
        <div
          className={styles.backdrop}
          onMouseDown={() => {
            if (!addingPlaylistId) setIsPickerOpen(false);
          }}
        >
          <section
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${track.title} to playlist`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className={styles.header}>
              <TrackArtwork
                className={styles.trackArtwork}
                artworkUrl={track.artworkUrl}
                iconSize={24}
                loading="eager"
              />
              <div className={styles.trackText}>
                <strong>{track.title}</strong>
                <small>{track.artist}</small>
              </div>
              <button
                type="button"
                className={styles.closeButton}
                disabled={Boolean(addingPlaylistId)}
                onClick={() => setIsPickerOpen(false)}
                aria-label="Close playlist picker"
              >
                <IconX size={19} />
              </button>
            </header>

            <label className={styles.search}>
              <IconSearch size={18} aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedPlaylistIndex(null);
                }}
                onKeyDown={handlePickerKeyDown}
                placeholder="Find a playlist"
                aria-label="Find a playlist"
              />
            </label>

            {error && <p className={styles.error}>{error}</p>}

            <div className={styles.playlistList}>
              {libraryState.status === "signed-out" ? (
                <p className={styles.empty}>Sign in to YouTube Music to add songs.</p>
              ) : playlists.length === 0 ? (
                <p className={styles.empty}>
                  {query ? "No matching playlists." : "No editable playlists were found."}
                </p>
              ) : (
                playlists.map((playlist, index) => (
                  <button
                    key={playlist.id}
                    ref={(element) => {
                      playlistRefs.current[index] = element;
                    }}
                    type="button"
                    className={`${styles.playlist} ${
                      selectedPlaylistIndex === index ? styles.keyboardSelected : ""
                    }`}
                    disabled={Boolean(addingPlaylistId)}
                    onMouseMove={() => setSelectedPlaylistIndex(null)}
                    onClick={() => void addToPlaylist(playlist)}
                  >
                    <span className={styles.playlistArtwork}>
                      {playlist.artworkUrl ? (
                        <img src={playlist.artworkUrl} alt="" />
                      ) : (
                        <IconPlaylist size={24} aria-hidden="true" />
                      )}
                    </span>
                    <span className={styles.playlistText}>
                      <strong>{playlist.title}</strong>
                      <span>{playlist.owner}</span>
                    </span>
                    {addingPlaylistId === playlist.id && (
                      <span className={styles.adding}>Adding...</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className={styles.toast} role="status">
          {addingPlaylistId || isRemovingTrack || isLikeMutationPending ? (
            <IconLoader2
              className={styles.toastLoadingIcon}
              size={18}
              aria-hidden="true"
            />
          ) : toast === "Already in playlist" ? (
            <IconX size={16} aria-hidden="true" />
          ) : (toast.startsWith("Added ") || toast === "Link copied" || toast.startsWith("Removed from ")) && (
            <IconCheck size={18} aria-hidden="true" />
          )}
          <span>{toast}</span>
        </div>
      )}
    </TrackContextMenuContext.Provider>
  );
}
