import { useEffect, useMemo, useRef, useState } from "react";
import { IconPlayerPlay } from "@tabler/icons-react";
import type { Track } from "../../datasource/types";
import type { LibraryController, LibraryState } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import type { SearchController } from "../../player/SearchController";
import { AlbumCard } from "../components/AlbumCard";
import { DiceCard } from "../components/DiceCard";
import { TrackArtwork } from "../components/TrackArtwork";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import styles from "./HomePage.module.css";
import { ArtistLinks } from "../components/ArtistLinks";

const FALLBACK_QUERIES = [
  "new music",
  "popular songs",
  "indie mix",
  "electronic mix",
  "late night music",
  "discover weekly",
];

const suggestionCache = new Map<string, Track[]>();
const suggestionLoads = new Map<string, Promise<Track[]>>();

interface HomePageProps {
  tabId: string;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
  libraryState: LibraryState;
  searchController: SearchController;
  onSignIn: () => Promise<void>;
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function uniqueTracks(tracks: readonly Track[]): Track[] {
  return [...new Map(tracks.map((track) => [track.id, track])).values()];
}

export function HomePage({
  tabId,
  playerController,
  libraryController,
  libraryState,
  searchController,
  onSignIn,
}: HomePageProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const [suggestions, setSuggestions] = useState<Track[]>(
    () => suggestionCache.get(tabId) ?? [],
  );
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(
    () => !suggestionCache.has(tabId),
  );
  const [isSurpriseSpinning, setIsSurpriseSpinning] = useState(false);
  const loadIdRef = useRef(0);
  const recentlyPlayed = libraryState.library?.recentlyPlayed ?? [];
  const recentTrackKey = recentlyPlayed.map((track) => track.id).join(":");

  useEffect(() => {
    const cached = suggestionCache.get(tabId);
    if (cached) {
      setSuggestions(cached);
      setIsLoadingSuggestions(false);
      return;
    }

    const loadId = ++loadIdRef.current;
    let loadPromise = suggestionLoads.get(tabId);
    if (!loadPromise) {
      loadPromise = (async () => {
      const seeds = shuffle(recentlyPlayed).slice(0, 3);
      let loaded: Track[] = [];

      if (seeds.length > 0) {
        const recommendationSets = await Promise.allSettled(
          seeds.map((seed) => libraryController.getRecommendations(seed)),
        );
        loaded = recommendationSets.flatMap((result) =>
          result.status === "fulfilled" ? result.value : []
        );
      }

      if (loaded.length < 12) {
        const query = FALLBACK_QUERIES[Math.floor(Math.random() * FALLBACK_QUERIES.length)];
        try {
          loaded.push(...await searchController.searchTracks(query));
        } catch {
          // Recent tracks still provide a useful offline fallback.
        }
      }

        return shuffle(uniqueTracks([...loaded, ...recentlyPlayed])).slice(0, 36);
      })();
      suggestionLoads.set(tabId, loadPromise);
    }

    void loadPromise.then((loadedSuggestions) => {
      suggestionCache.set(tabId, loadedSuggestions);
      suggestionLoads.delete(tabId);
      if (loadId !== loadIdRef.current) return;
      setSuggestions(loadedSuggestions);
      setIsLoadingSuggestions(false);
    });
  }, [libraryController, recentTrackKey, searchController, tabId]);

  const compactRecent = useMemo(() => recentlyPlayed.slice(0, 6), [recentTrackKey]);
  const largeRecent = useMemo(() => recentlyPlayed.slice(6), [recentTrackKey]);
  const topSuggestions = suggestions.slice(0, 11);
  const moreSuggestions = suggestions.slice(11, 23);
  const surpriseSuggestions = suggestions.slice(11);

  const playTrack = (track: Track, queue: readonly Track[]) => {
    void playerController.playTrackById(track.id, queue, true);
  };

  const playSurprise = () => {
    if (surpriseSuggestions.length === 0 || isSurpriseSpinning) return;
    setIsSurpriseSpinning(true);
    window.setTimeout(() => {
      const selected = surpriseSuggestions[
        Math.floor(Math.random() * surpriseSuggestions.length)
      ];
      setIsSurpriseSpinning(false);
      playTrack(selected, surpriseSuggestions);
    }, 720);
  };

  const madeForYouSection = (
    <section
      className={`${styles.section} ${
        isLoadingSuggestions ? styles.loadingRecommendations : styles.loadedRecommendations
      }`}
    >
        
      <div className={styles.sectionHeading}>
        <h1>Made for you</h1>
      </div>
      {isLoadingSuggestions ? (
        <div className={styles.suggestionSkeleton} aria-label="Loading suggestions" />
      ) : (
        <div className={styles.suggestionGrid}>
          <DiceCard
            tracks={surpriseSuggestions}
            isSpinning={isSurpriseSpinning}
            onClick={playSurprise}
          />
          {topSuggestions.map((track) => (
            <AlbumCard
              key={track.id}
              artworkUrl={track.artworkUrl}
              title={track.title}
              subtitleContent={<ArtistLinks artists={track.artists} fallback={track.artist} />}
              onContextMenu={(event) => openTrackMenu(event, track)}
              onClick={() => playTrack(track, suggestions)}
            />
          ))}
        </div>
      )}
  
    </section>
  );

  return (
    <div className={styles.root}>
      {libraryState.status === "signed-out" && (
        <section className={styles.signInBanner}>
          <div>
            <h1>You&apos;re not signed in</h1>
            <p>Sign in to access your history, playlists, and albums.</p>
          </div>
          <button type="button" onClick={() => void onSignIn()}>
            Sign in
          </button>
        </section>
      )}

      {!isLoadingSuggestions && madeForYouSection}

      {compactRecent.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Recently played</h2>
          <div className={styles.compactGrid}>
            {compactRecent.map((track) => (
              <button
                key={track.id}
                type="button"
                className={styles.compactTrack}
                onContextMenu={(event) => openTrackMenu(event, track)}
                onClick={() => playTrack(track, recentlyPlayed)}
              >
                <TrackArtwork
                  className={styles.compactArtwork}
                  artworkUrl={track.artworkUrl}
                  iconSize={24}
                />
                <span className={styles.compactText}>
                  <strong>{track.title}</strong>
                  <ArtistLinks artists={track.artists} fallback={track.artist} />
                </span>
                <IconPlayerPlay size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      {isLoadingSuggestions && madeForYouSection}

      {moreSuggestions.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>More recommendations</h2>
          <div className={styles.cardRail}>
            {moreSuggestions.map((track) => (
              <AlbumCard
                key={track.id}
                artworkUrl={track.artworkUrl}
                title={track.title}
                subtitleContent={<ArtistLinks artists={track.artists} fallback={track.artist} />}
                onContextMenu={(event) => openTrackMenu(event, track)}
                onClick={() => playTrack(track, suggestions)}
              />
            ))}
          </div>
        </section>
      )}

      {largeRecent.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Listen again</h2>
          <div className={styles.listenAgainGrid}>
            {largeRecent.map((track) => (
              <AlbumCard
                key={track.id}
                artworkUrl={track.artworkUrl}
                title={track.title}
                subtitleContent={<ArtistLinks artists={track.artists} fallback={track.artist} />}
                onContextMenu={(event) => openTrackMenu(event, track)}
                onClick={() => playTrack(track, recentlyPlayed)}
              />
            ))}
          </div>
        </section>
      )}

      {!isLoadingSuggestions && suggestions.length === 0 && (
        <div className={styles.emptyState}>
          <p>Recommendations could not be loaded.</p>
          {libraryState.status === "signed-out" && (
            <button onClick={() => void onSignIn()}>
              Sign in with YouTube Music
            </button>
          )}
        </div>
      )}
    </div>
  );
}
