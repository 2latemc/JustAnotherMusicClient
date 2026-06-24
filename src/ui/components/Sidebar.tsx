import { useState, useRef, useEffect, useMemo } from "react";
import {
  IconDisc,
  IconHeart,
  IconPlaylist,
  IconRefresh,
} from "@tabler/icons-react";
import type { Album, Playlist } from "../../datasource/types";
import { libraryController, useLibraryState } from "../../player/playerStore";
import {
  getRecentPlaylistTimestamp,
  subscribeToRecentPlaylists,
} from "../../player/recentPlaylists";
import styles from "./Sidebar.module.css";
import { ArtistLinks } from "./ArtistLinks";
import { TrackArtwork } from "./TrackArtwork";
 
const PLAYLIST_ORDER_KEY = "ytc-sidebar-playlist-order";
const ALBUM_ORDER_KEY = "ytc-sidebar-album-order";
const PLAYLIST_LIKED_ORDER_MIGRATION_KEY = "ytc-sidebar-playlist-liked-order-v1";
const ALBUM_LIKED_ORDER_MIGRATION_KEY = "ytc-sidebar-album-liked-order-v1";

function loadOrderFromStorage(key: string, migrationKey: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const order = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
    if (order.includes("LM") && localStorage.getItem(migrationKey) !== "true") {
      const migratedOrder = ["LM", ...order.filter((id) => id !== "LM")];
      localStorage.setItem(key, JSON.stringify(migratedOrder));
      localStorage.setItem(migrationKey, "true");
      return migratedOrder;
    }
    return order;
  } catch {
    return [];
  }
}

function saveOrderToStorage(key: string, order: string[], migrationKey?: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(order));
    if (migrationKey) localStorage.setItem(migrationKey, "true");
  } catch {
    // ignore storage failures
  }
}

function reorderIds(ids: string[], draggedId: string, targetId: string, insertAfter: boolean) {
  const nextIds = ids.filter((id) => id !== draggedId);
  const targetIndex = nextIds.indexOf(targetId);
  if (targetIndex < 0) return ids;
  const insertIndex = targetIndex + (insertAfter ? 1 : 0);
  nextIds.splice(insertIndex, 0, draggedId);
  return nextIds;
}

interface SidebarProps {
  width: number;
  onWidthChange: (width: number) => void;
  onNavigateAlbum: (album: Album) => void;
  onNavigatePlaylist: (playlist: Playlist) => void;
}

const MIN_WIDTH = 85;
const MAX_WIDTH = 300;
const COLLAPSED_WIDTH = 150;
const TEXT_HIDE_THRESHOLD = 120;

type LibraryView = "albums" | "playlists";
function SidebarAlbumArtwork({ album }: { album: Album }) {
  if (album.id === "LM") {
    return (
      <div className={`${styles.albumPreview} ${styles.albumPreviewFallback} ${styles.likedSongsPreview}`}>
        <IconHeart size={24} stroke={1.8} aria-hidden="true" />
      </div>
    );
  }

  return (
    <TrackArtwork
      className={styles.albumPreview}
      artworkUrl={album.artworkUrl}
      iconSize={24}
      variant="album"
    />
  );
}


function SidebarPlaylistArtwork({ playlist }: { playlist: Playlist }) {
  if (playlist.kind === "liked-songs" || playlist.id === "LM") {
    return (
      <div className={`${styles.albumPreview} ${styles.albumPreviewFallback} ${styles.likedSongsPreview}`}>
        <IconHeart size={24} stroke={1.8} aria-hidden="true" />
      </div>
    );
  }

  return (
    <TrackArtwork
      className={styles.albumPreview}
      artworkUrl={playlist.artworkUrl}
      iconSize={24}
      retryOnError
      variant="playlist"
    />
  );
}

export function Sidebar({
  width,
  onWidthChange,
  onNavigateAlbum,
  onNavigatePlaylist,
}: SidebarProps) {
  const libraryState = useLibraryState();
  const [libraryView, setLibraryView] = useState<LibraryView>("playlists");
  const [recentPlaylistsRevision, setRecentPlaylistsRevision] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [playlistOrder, setPlaylistOrder] = useState<string[]>(() =>
    loadOrderFromStorage(PLAYLIST_ORDER_KEY, PLAYLIST_LIKED_ORDER_MIGRATION_KEY)
  );
  const [albumOrder, setAlbumOrder] = useState<string[]>(() =>
    loadOrderFromStorage(ALBUM_ORDER_KEY, ALBUM_LIKED_ORDER_MIGRATION_KEY)
  );
  const [draggedItem, setDraggedItem] = useState<{ id: string; type: LibraryView } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; type: LibraryView; insertAfter: boolean } | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const draggedElementRef = useRef<HTMLElement | null>(null);
  const dragTranslationRef = useRef(0);
  const pointerDragRef = useRef<{
    pointerId: number;
    itemId: string;
    itemType: LibraryView;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const dragStartX = useRef<number | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragStartX.current = e.clientX;
    setIsDragging(true);
  };

  const isCollapsed = width <= COLLAPSED_WIDTH;
  const shouldHideText = width <= TEXT_HIDE_THRESHOLD;
  const hasUserCreatedPlaylists = (libraryState.library?.playlists.length ?? 0) > 0;
  const hasLoadedLibrary = Boolean(libraryState.library);
  const showPlaylistRetry =
    libraryView === "playlists" &&
    libraryState.status !== "signed-out" &&
    (hasLoadedLibrary || libraryState.status === "error") &&
    !hasUserCreatedPlaylists;
  const isRetryingPlaylists = libraryState.status === "loading";

  useEffect(() => {
    if (localStorage.getItem(PLAYLIST_LIKED_ORDER_MIGRATION_KEY) !== "true") {
      setPlaylistOrder((current) => {
        if (!current.includes("LM")) return current;
        const migrated = ["LM", ...current.filter((id) => id !== "LM")];
        saveOrderToStorage(
          PLAYLIST_ORDER_KEY,
          migrated,
          PLAYLIST_LIKED_ORDER_MIGRATION_KEY,
        );
        return migrated;
      });
    }

    if (localStorage.getItem(ALBUM_LIKED_ORDER_MIGRATION_KEY) !== "true") {
      setAlbumOrder((current) => {
        if (!current.includes("LM")) return current;
        const migrated = ["LM", ...current.filter((id) => id !== "LM")];
        saveOrderToStorage(
          ALBUM_ORDER_KEY,
          migrated,
          ALBUM_LIKED_ORDER_MIGRATION_KEY,
        );
        return migrated;
      });
    }
  }, []);

  const playlists = useMemo(() => {
    const likedSongsPlaylist = libraryState.library?.likedSongsPlaylist;
    const libraryPlaylists = likedSongsPlaylist
      ? [likedSongsPlaylist, ...(libraryState.library?.playlists ?? [])]
      : libraryState.library?.playlists ?? [];
    if (!libraryPlaylists.length) return [];

    const playlistById = new Map(libraryPlaylists.map((playlist) => [playlist.id, playlist]));
    const availableIds = new Set(libraryPlaylists.map((playlist) => playlist.id));
    const savedIds = playlistOrder.filter((id) => availableIds.has(id));

    if (savedIds.length) {
      const missingIds = libraryPlaylists
        .map((playlist) => playlist.id)
        .filter((id) => !savedIds.includes(id));
      const orderedIds = likedSongsPlaylist && !savedIds.includes(likedSongsPlaylist.id)
        ? [likedSongsPlaylist.id, ...savedIds, ...missingIds.filter((id) => id !== likedSongsPlaylist.id)]
        : [...savedIds, ...missingIds];
      return orderedIds
        .map((id) => playlistById.get(id))
        .filter((playlist): playlist is Playlist => Boolean(playlist));
    }

    const defaultPlaylists = libraryPlaylists
      .filter((playlist) => playlist.id !== likedSongsPlaylist?.id)
      .map((playlist, libraryIndex) => ({
        playlist,
        libraryIndex,
        playedAt: getRecentPlaylistTimestamp(playlist.id),
      }))
      .sort((left, right) =>
        right.playedAt - left.playedAt || left.libraryIndex - right.libraryIndex
      )
      .map(({ playlist }) => playlist);
    return likedSongsPlaylist
      ? [likedSongsPlaylist, ...defaultPlaylists]
      : defaultPlaylists;
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.playlists,
    playlistOrder,
    recentPlaylistsRevision,
  ]);

  const albums = useMemo(() => {
    const likedSongsPlaylist = libraryState.library?.likedSongsPlaylist;
    const likedSongsAlbum: Album | null = likedSongsPlaylist
      ? {
          id: likedSongsPlaylist.id,
          title: "Liked Songs",
          artist: likedSongsPlaylist.owner,
          artworkUrl: likedSongsPlaylist.artworkUrl,
        }
      : null;
    const libraryAlbums = likedSongsAlbum
      ? [likedSongsAlbum, ...(libraryState.library?.albums ?? [])]
      : libraryState.library?.albums ?? [];
    if (!libraryAlbums.length) return [];

    const albumById = new Map(libraryAlbums.map((album) => [album.id, album]));
    const availableIds = new Set(libraryAlbums.map((album) => album.id));
    const savedIds = albumOrder.filter((id) => availableIds.has(id));

    if (savedIds.length) {
      const missingIds = libraryAlbums
        .map((album) => album.id)
        .filter((id) => !savedIds.includes(id));
      const orderedIds = likedSongsAlbum && !savedIds.includes(likedSongsAlbum.id)
        ? [likedSongsAlbum.id, ...savedIds, ...missingIds.filter((id) => id !== likedSongsAlbum.id)]
        : [...savedIds, ...missingIds];
      return orderedIds
        .map((id) => albumById.get(id))
        .filter((album): album is Album => Boolean(album));
    }

    return libraryAlbums;
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.albums,
    albumOrder,
  ]);

  useEffect(
    () => subscribeToRecentPlaylists(
      () => setRecentPlaylistsRevision((revision) => revision + 1),
    ),
    [],
  );

  useEffect(() => {
    if (!libraryState.library) return;
    const playlistIds = [
      libraryState.library.likedSongsPlaylist.id,
      ...libraryState.library.playlists.map((playlist) => playlist.id),
    ];
    if (playlistOrder.length > 0) {
      const normalized = [
        ...(playlistOrder.includes("LM") ? [] : ["LM"]),
        ...playlistOrder.filter((id) => playlistIds.includes(id)),
        ...playlistIds.filter((id) => !playlistOrder.includes(id)),
      ].filter((id, index, ids) => ids.indexOf(id) === index);
      if (
        normalized.length !== playlistOrder.length ||
        normalized.some((id, index) => id !== playlistOrder[index])
      ) {
        setPlaylistOrder(normalized);
        saveOrderToStorage(
          PLAYLIST_ORDER_KEY,
          normalized,
          PLAYLIST_LIKED_ORDER_MIGRATION_KEY,
        );
      }
    }
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.playlists,
    playlistOrder,
  ]);

  useEffect(() => {
    if (!libraryState.library) return;
    const albumIds = [
      libraryState.library.likedSongsPlaylist.id,
      ...libraryState.library.albums.map((album) => album.id),
    ];
    if (albumOrder.length > 0) {
      const normalized = [
        ...(albumOrder.includes("LM") ? [] : ["LM"]),
        ...albumOrder.filter((id) => albumIds.includes(id)),
        ...albumIds.filter((id) => !albumOrder.includes(id)),
      ].filter((id, index, ids) => ids.indexOf(id) === index);
      if (
        normalized.length !== albumOrder.length ||
        normalized.some((id, index) => id !== albumOrder[index])
      ) {
        setAlbumOrder(normalized);
        saveOrderToStorage(
          ALBUM_ORDER_KEY,
          normalized,
          ALBUM_LIKED_ORDER_MIGRATION_KEY,
        );
      }
    }
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.albums,
    albumOrder,
  ]);

  const playlistsRef = useRef<string[]>([]);
  const albumsRef = useRef<string[]>([]);

  useEffect(() => {
    playlistsRef.current = playlists.map((playlist) => playlist.id);
  }, [playlists]);

  useEffect(() => {
    albumsRef.current = albums.map((album) => album.id);
  }, [albums]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance < 6) return;

        drag.isDragging = true;
        setDraggedItem({ id: drag.itemId, type: drag.itemType });
      }

      const translationY = event.clientY - drag.startY;
      dragTranslationRef.current = translationY;
      if (draggedElementRef.current) {
        draggedElementRef.current.style.setProperty("--drag-translation", `${translationY}px`);
      }
      event.preventDefault();
      const pointerCandidates = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-sidebar-item-id]"))
        .filter((candidate): candidate is HTMLElement => Boolean(candidate))
        .filter((candidate) =>
          candidate.dataset.sidebarItemId !== drag.itemId &&
          candidate.dataset.sidebarItemType === drag.itemType,
        );

      const uniqueCandidates = Array.from(
        new Map(pointerCandidates.map((item) => [item.dataset.sidebarItemId, item])).values(),
      );

      let targetElement = uniqueCandidates.length
        ? uniqueCandidates.reduce<HTMLElement | null>((closestSoFar, item) => {
            const itemRect = item.getBoundingClientRect();
            const centerY = itemRect.top + itemRect.height / 2;
            if (!closestSoFar) return item;
            const closestRect = closestSoFar.getBoundingClientRect();
            const closestCenterY = closestRect.top + closestRect.height / 2;
            return Math.abs(centerY - event.clientY) < Math.abs(closestCenterY - event.clientY)
              ? item
              : closestSoFar;
          }, null)
        : null;

      if (listRef.current) {
        const listRect = listRef.current.getBoundingClientRect();
        const items = Array.from(
          listRef.current.querySelectorAll<HTMLElement>("[data-sidebar-item-id]")
        ).filter((item) =>
          item.dataset.sidebarItemId !== drag.itemId &&
          item.dataset.sidebarItemType === drag.itemType,
        );

        if (event.clientY < listRect.top && items.length) {
          targetElement = items[0];
        } else if (event.clientY > listRect.bottom && items.length) {
          targetElement = items[items.length - 1];
        } else if (!targetElement && event.clientY >= listRect.top && event.clientY <= listRect.bottom && items.length) {
          targetElement = items.reduce<HTMLElement | null>((closestSoFar, item) => {
            const itemRect = item.getBoundingClientRect();
            const centerY = itemRect.top + itemRect.height / 2;
            if (!closestSoFar) return item;
            const closestRect = closestSoFar.getBoundingClientRect();
            const closestCenterY = closestRect.top + closestRect.height / 2;
            return Math.abs(centerY - event.clientY) < Math.abs(closestCenterY - event.clientY)
              ? item
              : closestSoFar;
          }, null);
        }
      }

      if (!targetElement) {
        setDropTarget(null);
        return;
      }

      const targetId = targetElement.dataset.sidebarItemId;
      const targetType = targetElement.dataset.sidebarItemType as LibraryView | undefined;
      if (!targetId || !targetType || targetId === drag.itemId || targetType !== drag.itemType) {
        setDropTarget(null);
        return;
      }

      const bounds = targetElement.getBoundingClientRect();
      setDropTarget({
        id: targetId,
        type: targetType,
        insertAfter: event.clientY >= bounds.top + bounds.height / 2,
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (drag.isDragging && dropTarget && dropTarget.type === drag.itemType && dropTarget.id !== drag.itemId) {
        const currentIds =
          drag.itemType === "playlists" ? playlistsRef.current : albumsRef.current;
        const nextOrder = reorderIds(
          currentIds,
          drag.itemId,
          dropTarget.id,
          dropTarget.insertAfter,
        );

        if (drag.itemType === "playlists") {
          setPlaylistOrder(nextOrder);
          saveOrderToStorage(
            PLAYLIST_ORDER_KEY,
            nextOrder,
            PLAYLIST_LIKED_ORDER_MIGRATION_KEY,
          );
        } else {
          setAlbumOrder(nextOrder);
          saveOrderToStorage(
            ALBUM_ORDER_KEY,
            nextOrder,
            ALBUM_LIKED_ORDER_MIGRATION_KEY,
          );
        }

        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }

      pointerDragRef.current = null;
      if (draggedElementRef.current) {
        draggedElementRef.current.style.removeProperty("--drag-translation");
        draggedElementRef.current.releasePointerCapture?.(event.pointerId);
        draggedElementRef.current.style.removeProperty("will-change");
      }
      draggedElementRef.current = null;
      setDraggedItem(null);
      setDropTarget(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dropTarget]);

  const handleSidebarItemPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    itemId: string,
    itemType: LibraryView,
  ) => {
    if (event.button !== 0) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      itemId,
      itemType,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
    };
    draggedElementRef.current = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.willChange = "transform";
  };

  const handleSidebarItemClick = (callback: () => void) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    callback();
  };

  const handlePlaylistRetry = () => {
    if (isRetryingPlaylists) return;
    void libraryController.refresh();
  };

  const isDragActive = Boolean(draggedItem);

  const listClasses = `${styles.albumList} ${isDragActive ? styles.dragActive : ""}`;

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragStartX.current === null || !sidebarRef.current) return;

      const moved = Math.abs(e.clientX - dragStartX.current);
      if (moved < 4) return;

      const rect = sidebarRef.current.getBoundingClientRect();
      const newWidth = e.clientX - rect.left;
      onWidthChange(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth)));
    };

    const handleMouseUp = () => {
      dragStartX.current = null;
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onWidthChange]);

  return (
    <div 
      ref={sidebarRef}
      className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ""}`}
      style={{ width: `${width}px` }}
    >
      <div 
        className={`${styles.dragHandle} ${isDragging ? styles.dragHandleActive : ""}`}
        onMouseDown={handleMouseDown}
        title="Drag to resize sidebar"
      />

      <div className={styles.albumsSection}>
        <div className={`${styles.libraryToggle} ${shouldHideText ? styles.compactToggle : ""}`} role="group" aria-label="Library view">
          <button
            type="button"
            className={`${styles.toggleButton} ${libraryView === "playlists" ? styles.activeToggle : ""}`}
            aria-pressed={libraryView === "playlists"}
            title="User playlists"
            onClick={() => setLibraryView("playlists")}
          >
            <IconPlaylist size={17} aria-hidden="true" />
            {!shouldHideText && <span>Playlists</span>}
          </button>
          <button
            type="button"
            className={`${styles.toggleButton} ${libraryView === "albums" ? styles.activeToggle : ""}`}
            aria-pressed={libraryView === "albums"}
            title="Albums"
            onClick={() => setLibraryView("albums")}
          >
            <IconDisc size={17} aria-hidden="true" />
            {!shouldHideText && <span>Albums</span>}
          </button>
        </div>
        <div ref={listRef} className={listClasses}>
          {libraryView === "albums" ? (
            albums.map((album) => (
              <button
                type="button"
                key={album.id}
                data-sidebar-item-id={album.id}
                data-sidebar-item-type="albums"
                className={`${styles.albumItem} ${shouldHideText ? styles.centered : ""} ${draggedItem?.id === album.id && draggedItem.type === "albums" ? styles.dragging : ""} ${dropTarget?.id === album.id && dropTarget?.type === "albums" && !dropTarget.insertAfter ? styles.dropBefore : ""} ${dropTarget?.id === album.id && dropTarget?.type === "albums" && dropTarget.insertAfter ? styles.dropAfter : ""}`}
                onPointerDown={(event) => handleSidebarItemPointerDown(event, album.id, "albums")}
                onClick={() => handleSidebarItemClick(() => {
                  if (album.id === "LM" && libraryState.library?.likedSongsPlaylist) {
                    onNavigatePlaylist(libraryState.library.likedSongsPlaylist);
                  } else {
                    onNavigateAlbum(album);
                  }
                })}
                title={shouldHideText ? `${album.title} by ${album.artist}` : undefined}
              >
                <SidebarAlbumArtwork album={album} />
                {!shouldHideText && (
                  <div className={styles.albumText}>
                    <span className={styles.albumTitle}>{album.title}</span>
                    <ArtistLinks
                      className={styles.albumArtist}
                      artists={album.artists}
                      fallback={album.artist}
                    />
                  </div>
                )}
              </button>
            ))
          ) : (
            playlists.length ? (
              <>
                {playlists.map((playlist) => (
                  <button
                    type="button"
                    key={playlist.id}
                    data-sidebar-item-id={playlist.id}
                    data-sidebar-item-type="playlists"
                    className={`${styles.albumItem} ${shouldHideText ? styles.centered : ""} ${draggedItem?.id === playlist.id && draggedItem.type === "playlists" ? styles.dragging : ""} ${dropTarget?.id === playlist.id && dropTarget?.type === "playlists" && !dropTarget.insertAfter ? styles.dropBefore : ""} ${dropTarget?.id === playlist.id && dropTarget?.type === "playlists" && dropTarget.insertAfter ? styles.dropAfter : ""}`}
                    onPointerDown={(event) => handleSidebarItemPointerDown(event, playlist.id, "playlists")}
                    onClick={() => handleSidebarItemClick(() => onNavigatePlaylist(playlist))}
                    title={shouldHideText ? `${playlist.title} by ${playlist.owner}` : undefined}
                  >
                    <SidebarPlaylistArtwork playlist={playlist} />
                    {!shouldHideText && (
                      <div className={styles.albumText}>
                        <span className={styles.albumTitle}>{playlist.title}</span>
                        <span className={styles.albumArtist}>{playlist.owner}</span>
                      </div>
                    )}
                  </button>
                ))}
                {showPlaylistRetry && (
                  <div className={styles.emptyLibraryView}>
                    <IconPlaylist size={28} aria-hidden="true" />
                    {!shouldHideText && (
                      <span>No user-created playlists were found.</span>
                    )}
                    <button
                      type="button"
                      className={styles.libraryRetryButton}
                      onClick={handlePlaylistRetry}
                      disabled={isRetryingPlaylists}
                      title="Retry playlist sync"
                      aria-label="Retry playlist sync"
                    >
                      <IconRefresh size={15} aria-hidden="true" />
                      {!shouldHideText && (
                        <span>{isRetryingPlaylists ? "Retrying..." : "Retry"}</span>
                      )}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.emptyLibraryView}>
                <IconPlaylist size={28} aria-hidden="true" />
                {!shouldHideText && (
                  <span>
                    {libraryState.status === "signed-out"
                      ? "Sign in to see your playlists."
                      : "No user-created playlists were found."}
                  </span>
                )}
                {libraryState.status === "signed-out" && (
                  <button
                    type="button"
                    className={styles.librarySignInButton}
                    onClick={() => void libraryController.signIn()}
                    title="Sign in to YouTube Music"
                  >
                    Sign in
                  </button>
                )}
                {showPlaylistRetry && (
                  <button
                    type="button"
                    className={styles.libraryRetryButton}
                    onClick={handlePlaylistRetry}
                    disabled={isRetryingPlaylists}
                    title="Retry playlist sync"
                    aria-label="Retry playlist sync"
                  >
                    <IconRefresh size={15} aria-hidden="true" />
                    {!shouldHideText && (
                      <span>{isRetryingPlaylists ? "Retrying..." : "Retry"}</span>
                    )}
                  </button>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
