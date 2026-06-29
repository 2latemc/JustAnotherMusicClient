import { useEffect, useRef, useState } from "react";
import { IconClock, IconSearch, IconX } from "@tabler/icons-react";
import type { Album, Artist, Playlist, SearchResults, Track } from "../../datasource/types";
import type { SearchController } from "../../player/SearchController";
import { TrackArtwork } from "./TrackArtwork";
import { useTrackContextMenu } from "./TrackContextMenu";
import { isMacOS, primaryModifierLabel } from "../platform";
import styles from "./SearchOverlay.module.css";
import { usePlaylistContextMenu } from "./PlaylistContextMenu";

const RECENT_SEARCHES_KEY = "yt-music-dock:recent-searches";
const MAX_RECENT_SEARCHES = 5;

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizeSearchKey(value: string): string {
  return normalizeSearchText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function searchMatchScore(value: string, query: string): number {
  const normalizedValue = normalizeSearchText(value);
  const normalizedValueKey = normalizeSearchKey(value);
  const queryKey = normalizeSearchKey(query);
  if (!normalizedValue || !query) return 0;
  if (normalizedValue === query) return 4;
  if (normalizedValueKey && queryKey && normalizedValueKey === queryKey) return 4;
  if (normalizedValue.startsWith(query)) return 3;
  if (normalizedValueKey && queryKey && normalizedValueKey.startsWith(queryKey)) return 3;
  if (normalizedValue.includes(query)) return 2;
  if (normalizedValueKey && queryKey && normalizedValueKey.includes(queryKey)) return 2;
  if (query.includes(normalizedValue)) return 1;
  if (normalizedValueKey && queryKey && queryKey.includes(normalizedValueKey)) return 1;
  return 0;
}

function loadRecentSearches(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT_SEARCHES)
      : [];
  } catch {
    return [];
  }
}

interface SearchOverlayProps {
  isOpen: boolean;
  activeTabId: string;
  searchController: SearchController;
  albums: Album[];
  playlists: Playlist[];
  onClose: () => void;
  onDismiss?: () => void;
  onSubmit: (query: string, openInNewTab: boolean) => void;
  onPlayTrack: (track: Track) => void;
  onOpenArtist: (artist: Artist) => void;
  onOpenAlbum: (album: Album) => void;
  onOpenPlaylist: (playlist: Playlist) => void;
  onQueryChange?: (query: string) => void;
}

export function SearchOverlay({
  isOpen,
  activeTabId,
  searchController,
  albums,
  playlists,
  onClose,
  onDismiss,
  onSubmit,
  onPlayTrack,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onQueryChange,
}: SearchOverlayProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu, openAlbumMenu } = usePlaylistContextMenu();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const modifiersRef = useRef({ primary: false, shift: false });
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults>({
    artists: [],
    tracks: [],
    albums: [],
    playlists: [],
  });
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState(loadRecentSearches);

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSearchResults({ artists: [], tracks: [], albums: [], playlists: [] });
    setSuggestions([]);
    setSelectedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [activeTabId, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const updateModifier = (event: KeyboardEvent, pressed: boolean) => {
      if (event.key === (isMacOS ? "Meta" : "Control")) {
        modifiersRef.current.primary = pressed;
      }
      if (event.key === "Shift") modifiersRef.current.shift = pressed;
    };
    const resetModifiers = () => {
      modifiersRef.current = { primary: false, shift: false };
    };
    const handleKeyDown = (event: KeyboardEvent) => updateModifier(event, true);
    const handleKeyUp = (event: KeyboardEvent) => updateModifier(event, false);

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", resetModifiers);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", resetModifiers);
      resetModifiers();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || query.trim().length < 2) {
      requestIdRef.current += 1;
      setSearchResults({ artists: [], tracks: [], albums: [], playlists: [] });
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    const timeoutId = window.setTimeout(() => {
      const updatePreview = (results: SearchResults) => {
        if (requestId === requestIdRef.current) setSearchResults(results);
      };
      const updateSuggestions = (nextSuggestions: string[]) => {
        if (requestId === requestIdRef.current) setSuggestions(nextSuggestions);
      };
      void Promise.allSettled([
        searchController.search(query, updatePreview),
        searchController.getSearchSuggestions(query, updateSuggestions),
      ])
        .then(([resultsResult, suggestionsResult]) => {
          if (requestId !== requestIdRef.current) return;
          setSearchResults(
            resultsResult.status === "fulfilled"
              ? resultsResult.value
              : { artists: [], tracks: [], albums: [], playlists: [] },
          );
          setSuggestions(
            suggestionsResult.status === "fulfilled"
              ? suggestionsResult.value
              : [],
          );
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setIsLoading(false);
        });
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, query, searchController]);

  if (!isOpen) return null;

  const libraryPreview = (() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length < 2) return null;

    const matchTitle = <T extends Album | Playlist>(items: T[]) => {
      const matches = items.filter((item) =>
        item.title.toLocaleLowerCase().includes(normalizedQuery)
      );
      return matches.find(
        (item) => item.title.toLocaleLowerCase() === normalizedQuery
      ) ?? matches[0] ?? null;
    };

    const playlist = matchTitle(playlists);
    if (playlist) return { type: "playlist" as const, value: playlist };

    const album = matchTitle(albums);
    if (album) return { type: "album" as const, value: album };

    return null;
  })();
  const remotePreview = (() => {
    const normalizedQuery = normalizeSearchText(query);
    const rankedArtist = searchResults.artists
      .map((artist) => ({
        artist,
        score: searchMatchScore(artist.name, normalizedQuery),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)[0];
    const rankedTrack = searchResults.tracks
      .map((track) => ({
        track,
        score: searchMatchScore(track.title, normalizedQuery),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)[0];

    if (rankedArtist && (!rankedTrack || rankedArtist.score >= rankedTrack.score)) {
      return { type: "artist" as const, value: rankedArtist.artist };
    }
    if (rankedTrack) return { type: "track" as const, value: rankedTrack.track };
    if (searchResults.tracks[0]) {
      return { type: "track" as const, value: searchResults.tracks[0] };
    }
    if (searchResults.artists[0]) {
      return { type: "artist" as const, value: searchResults.artists[0] };
    }
    if (searchResults.albums[0]) {
      return { type: "album" as const, value: searchResults.albums[0] };
    }
    if (searchResults.playlists[0]) {
      return { type: "playlist" as const, value: searchResults.playlists[0] };
    }
    return null;
  })();
  const normalizedPreviewQuery = normalizeSearchText(query);
  const preview = remotePreview?.type === "artist"
    && normalizeSearchText(remotePreview.value.name) === normalizedPreviewQuery
    ? remotePreview
    : libraryPreview ?? remotePreview;
  const visibleRecentSearches = query ? [] : recentSearches;
  const previewOffset = preview ? 1 : 0;
  const selectableCount =
    1 + previewOffset + suggestions.length + visibleRecentSearches.length;

  const rememberSearch = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    const next = [normalized, ...recentSearches.filter((item) => item !== normalized)]
      .slice(0, MAX_RECENT_SEARCHES);
    setRecentSearches(next);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  };

  const removeRecentSearch = (value: string) => {
    const next = recentSearches.filter((item) => item !== value);
    setRecentSearches(next);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
    setSelectedIndex(0);
  };

  const submitQuery = (value: string, openInNewTab: boolean) => {
    const normalized = value.trim();
    if (!normalized) return;
    onQueryChange?.(normalized);
    rememberSearch(normalized);
    onSubmit(normalized, openInNewTab);
    onClose();
  };

  const openPreview = () => {
    if (!preview) return;
    if (preview.type === "playlist") onOpenPlaylist(preview.value);
    if (preview.type === "album") onOpenAlbum(preview.value);
    if (preview.type === "artist") onOpenArtist(preview.value);
    if (preview.type === "track") onPlayTrack(preview.value);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      (onDismiss ?? onClose)();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((current) =>
        (current + direction + selectableCount) % selectableCount
      );
      return;
    }

    if (event.key !== "Enter") return;
    event.preventDefault();
    const openInNewTab =
      (isMacOS ? event.metaKey : event.ctrlKey)
      || event.shiftKey
      || modifiersRef.current.primary
      || modifiersRef.current.shift;

    if (selectedIndex === 0) {
      submitQuery(query, openInNewTab);
      return;
    }

    if (preview) {
      if (selectedIndex === 1) {
        openPreview();
        return;
      }
    }

    const suggestionIndex = selectedIndex - 1 - previewOffset;
    const suggestion = suggestions[suggestionIndex];
    if (suggestion) {
      submitQuery(suggestion, openInNewTab);
      return;
    }

    const recentSearchIndex = suggestionIndex - suggestions.length;
    const recentSearch = visibleRecentSearches[recentSearchIndex];
    if (recentSearch) submitQuery(recentSearch, openInNewTab);
  };

  return (
    <div className={styles.backdrop} onMouseDown={onDismiss ?? onClose}>
      <section
        className={styles.panel}
        data-onboarding="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search artists, songs, playlists, and albums"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={`${styles.inputRow} ${selectedIndex === 0 ? styles.selected : ""}`}>
          <IconSearch size={21} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              onQueryChange?.(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search artists, songs, playlists, and albums"
            aria-label="Search artists, songs, playlists, and albums"
          />
          {isLoading && <span className={styles.loading}>Searching</span>}
        </div>

        {preview && (
          <button
            type="button"
            className={`${styles.result} ${selectedIndex === 1 ? styles.selected : ""}`}
            onMouseEnter={() => setSelectedIndex(1)}
            onContextMenu={preview.type === "track"
              ? (event) => openTrackMenu(event, preview.value)
              : preview.type === "playlist"
                ? (event) => openPlaylistMenu(event, preview.value)
                : preview.type === "album"
                  ? (event) => openAlbumMenu(event, preview.value)
                  : undefined}
            onClick={openPreview}
          >
            <TrackArtwork
              className={styles.artwork}
              artworkUrl={preview.value.artworkUrl}
              iconSize={26}
              loading="eager"
              variant={preview.type === "artist" ? "artist" : "track"}
            />
            <span className={styles.trackText}>
              <strong>
                {preview.type === "artist" ? preview.value.name : preview.value.title}
              </strong>
              <span>
                {preview.type === "playlist"
                  ? `Playlist - ${preview.value.owner}`
                  : preview.type === "album"
                    ? `Album - ${preview.value.artist}`
                    : preview.type === "artist"
                      ? preview.value.subscriberCount || "Artist"
                    : preview.value.artist}
              </span>
            </span>
            <span className={styles.hint}>
              {preview.type === "track" ? "Play" : "Open"}
            </span>
          </button>
        )}

        {suggestions.length > 0 && (
          <div className={styles.suggestions}>
            {suggestions.map((suggestion, index) => {
              const itemIndex = 1 + previewOffset + index;
              return (
                <button
                  key={suggestion}
                  type="button"
                  className={`${styles.suggestion} ${
                    selectedIndex === itemIndex ? styles.selected : ""
                  }`}
                  onMouseEnter={() => setSelectedIndex(itemIndex)}
                  onClick={() => submitQuery(suggestion, false)}
                >
                  <IconSearch size={16} />
                  <span>{suggestion}</span>
                </button>
              );
            })}
          </div>
        )}

        {visibleRecentSearches.length > 0 && (
          <div className={styles.recents}>
            <p>Recent searches</p>
            {visibleRecentSearches.map((recentSearch, index) => {
              const itemIndex = 1 + previewOffset + suggestions.length + index;
              return (
              <div
                key={recentSearch}
                className={`${styles.recent} ${
                  selectedIndex === itemIndex ? styles.selected : ""
                }`}
                onMouseEnter={() => setSelectedIndex(itemIndex)}
              >
                <button
                  type="button"
                  className={styles.recentSearchButton}
                  onClick={() => submitQuery(recentSearch, false)}
                >
                  <IconClock size={17} />
                  <span>{recentSearch}</span>
                </button>
                <button
                  type="button"
                  className={styles.removeRecentButton}
                  onClick={() => removeRecentSearch(recentSearch)}
                  aria-label={`Remove ${recentSearch} from recent searches`}
                >
                  <IconX size={15} />
                </button>
              </div>
              );
            })}
          </div>
        )}

        <footer className={styles.footer}>
          <span>Enter search</span>
          <span>Shift or {primaryModifierLabel} + Enter new tab</span>
          <span>Esc close</span>
        </footer>
      </section>
    </div>
  );
}
