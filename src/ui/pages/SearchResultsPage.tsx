import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconPlayerPlay } from "@tabler/icons-react";
import type {
  Album,
  Artist,
  Playlist,
  SearchResults,
  Track,
} from "../../datasource/types";
import type { PlayerControllerActions } from "../../player/playerStore";
import { AlbumCard } from "../components/AlbumCard";
import { ArtistLinks } from "../components/ArtistLinks";
import { TrackArtwork } from "../components/TrackArtwork";
import { usePlaylistContextMenu } from "../components/PlaylistContextMenu";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import styles from "./SearchResultsPage.module.css";

function normalizeSearchKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

type SelectableItem =
  | { kind: "artist"; artist: Artist }
  | { kind: "track"; track: Track }
  | { kind: "album"; album: Album }
  | { kind: "playlist"; playlist: Playlist };

function buildFlatItems(results: SearchResults, songsFirst: boolean): SelectableItem[] {
  const items: SelectableItem[] = [];
  if (results.artists.length > 0 && !songsFirst) {
    for (const artist of results.artists) items.push({ kind: "artist", artist });
  }
  for (const track of results.tracks) items.push({ kind: "track", track });
  if (results.artists.length > 0 && songsFirst) {
    for (const artist of results.artists) items.push({ kind: "artist", artist });
  }
  for (const album of results.albums) items.push({ kind: "album", album });
  for (const playlist of results.playlists) items.push({ kind: "playlist", playlist });
  return items;
}

export function SearchResultsPage({
  query,
  results,
  isLoading,
  playerController,
  onPlayTrack,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
}: {
  query: string;
  results: SearchResults;
  isLoading: boolean;
  playerController: PlayerControllerActions;
  onPlayTrack?: (track: Track) => Promise<void> | void;
  onOpenArtist: (artist: Artist) => void;
  onOpenAlbum: (album: Album) => void;
  onOpenPlaylist: (playlist: Playlist) => void;
}) {
  const { openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu } = usePlaylistContextMenu();
  const hasResults = results.artists.length
    + results.tracks.length
    + results.albums.length
    + results.playlists.length > 0;
  const normalizedQuery = normalizeSearchKey(query);
  const hasExactArtist = results.artists.some(
    (artist) => normalizeSearchKey(artist.name) === normalizedQuery,
  );
  const hasExactTrack = results.tracks.some(
    (track) => normalizeSearchKey(track.title) === normalizedQuery,
  );
  const songsFirst = hasExactTrack && !hasExactArtist;

  const playTrack = useCallback((track: Track) => {
    if (onPlayTrack) void onPlayTrack(track);
    else void playerController.playTrackById(track.id, results.tracks, true);
  }, [onPlayTrack, playerController, results.tracks]);

  const flatItems = useMemo(
    () => buildFlatItems(results, songsFirst),
    [results, songsFirst],
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isKeyboardNav, setIsKeyboardNav] = useState(false);

  useEffect(() => {
    setSelectedIndex(0);
    setIsKeyboardNav(false);
  }, [results]);

  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;
  const hasResultsRef = useRef(hasResults);
  hasResultsRef.current = hasResults;
  const resultsRef = useRef(results);
  resultsRef.current = results;

  const onOpenArtistRef = useRef(onOpenArtist);
  onOpenArtistRef.current = onOpenArtist;
  const onOpenAlbumRef = useRef(onOpenAlbum);
  onOpenAlbumRef.current = onOpenAlbum;
  const onOpenPlaylistRef = useRef(onOpenPlaylist);
  onOpenPlaylistRef.current = onOpenPlaylist;
  const onPlayTrackRef = useRef(onPlayTrack);
  onPlayTrackRef.current = onPlayTrack;
  const playerControllerRef = useRef(playerController);
  playerControllerRef.current = playerController;

  useEffect(() => {
    if (isLoading || !hasResultsRef.current) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIsKeyboardNav(true);
        setSelectedIndex((prev) => Math.min(prev + 1, flatItemsRef.current.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIsKeyboardNav(true);
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        const item = flatItemsRef.current[selectedIndexRef.current];
        if (!item) return;
        event.preventDefault();
        switch (item.kind) {
          case "artist":
            onOpenArtistRef.current(item.artist);
            break;
          case "track": {
            const track = item.track;
            if (onPlayTrackRef.current) {
              void onPlayTrackRef.current(track);
            } else {
              void playerControllerRef.current.playTrackById(
                track.id,
                resultsRef.current.tracks,
                true,
              );
            }
            break;
          }
          case "album":
            onOpenAlbumRef.current(item.album);
            break;
          case "playlist":
            onOpenPlaylistRef.current(item.playlist);
            break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLoading]);

  useEffect(() => {
    if (!isKeyboardNav) return;
    const el = document.querySelector(`[data-selectable-index="${selectedIndex}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex, isKeyboardNav]);

  const handleMouseEnter = useCallback((index: number) => {
    setIsKeyboardNav(false);
    setSelectedIndex(index);
  }, []);

  const selected = useCallback(
    (index: number) => (isKeyboardNav && index === selectedIndex ? styles.selected : ""),
    [isKeyboardNav, selectedIndex],
  );

  const selectedAlbumCard = useCallback(
    (index: number) =>
      isKeyboardNav && index === selectedIndex ? styles.selectedAlbumCard : "",
    [isKeyboardNav, selectedIndex],
  );

  return (
    <div className={styles.root}>
      <header>
        <p className={styles.label}>Search results</p>
        <h1>{query}</h1>
      </header>

      {isLoading ? (
        <p className={styles.empty}>Searching...</p>
      ) : !hasResults ? (
        <p className={styles.empty}>No results found.</p>
      ) : (
        <div className={styles.sections}>
          {results.artists.length > 0 && (
            <section className={styles.section} style={{ order: songsFirst ? 1 : 0 }}>
              <h2>Artists</h2>
              <div className={styles.cardGrid}>
                {results.artists.map((artist) => {
                  const index = flatItems.findIndex(
                    (item) => item.kind === "artist" && item.artist.id === artist.id,
                  );
                  return (
                    <button
                      key={artist.id}
                      type="button"
                      data-selectable-index={index}
                      className={`${styles.artistCard} ${selected(index)}`}
                      onClick={() => onOpenArtist(artist)}
                      onMouseEnter={() => handleMouseEnter(index)}
                    >
                      <TrackArtwork
                        className={styles.artistArtwork}
                        artworkUrl={artist.artworkUrl}
                        iconSize={42}
                        variant="artist"
                      />
                      <strong>{artist.name}</strong>
                      <span>{artist.subscriberCount || "Artist"}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {results.tracks.length > 0 && (
            <section className={styles.section} style={{ order: songsFirst ? 0 : 1 }}>
              <h2>Songs</h2>
              <div className={styles.list} data-onboarding="search-results">
                {results.tracks.map((track, displayIndex) => {
                  const index = flatItems.findIndex(
                    (item) => item.kind === "track" && item.track.id === track.id,
                  );
                  return (
                    <button
                      key={track.id}
                      type="button"
                      data-selectable-index={index}
                      className={`${styles.track} ${selected(index)}`}
                      onContextMenu={(event) => openTrackMenu(event, track)}
                      onClick={() => playTrack(track)}
                      onMouseEnter={() => handleMouseEnter(index)}
                    >
                      <span className={styles.index}>{displayIndex + 1}</span>
                      <TrackArtwork
                        className={styles.artwork}
                        artworkUrl={track.artworkUrl}
                        iconSize={24}
                      />
                      <span className={styles.text}>
                        <strong>{track.title}</strong>
                        <ArtistLinks artists={track.artists} fallback={track.artist} />
                      </span>
                      <IconPlayerPlay size={18} />
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {results.albums.length > 0 && (
            <section className={styles.section} style={{ order: 2 }}>
              <h2>Albums</h2>
              <div className={styles.cardGrid}>
                {results.albums.map((album) => {
                  const index = flatItems.findIndex(
                    (item) => item.kind === "album" && item.album.id === album.id,
                  );
                  return (
                    <div
                      key={album.id}
                      data-selectable-index={index}
                      className={selectedAlbumCard(index)}
                      onMouseEnter={() => handleMouseEnter(index)}
                    >
                      <AlbumCard
                        artworkUrl={album.artworkUrl}
                        title={album.title}
                        subtitleContent={(
                          <ArtistLinks artists={album.artists} fallback={album.artist} />
                        )}
                        onClick={() => onOpenAlbum(album)}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {results.playlists.length > 0 && (
            <section className={styles.section} style={{ order: 3 }}>
              <h2>Playlists</h2>
              <div className={styles.cardGrid}>
                {results.playlists.map((playlist) => {
                  const index = flatItems.findIndex(
                    (item) => item.kind === "playlist" && item.playlist.id === playlist.id,
                  );
                  return (
                    <div
                      key={playlist.id}
                      data-selectable-index={index}
                      className={selectedAlbumCard(index)}
                      onMouseEnter={() => handleMouseEnter(index)}
                    >
                      <AlbumCard
                        artworkUrl={playlist.artworkUrl}
                        title={playlist.title}
                        subtitle={playlist.owner}
                        onClick={() => onOpenPlaylist(playlist)}
                        onContextMenu={(event) => openPlaylistMenu(event, playlist)}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}