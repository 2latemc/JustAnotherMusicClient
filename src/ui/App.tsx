import { useEffect, useRef, useState } from "react";
import type { Album, Playlist, Track } from "../datasource/types";
import { useDisableContextMenu } from "./hooks/useDisableContextMenu";
import { HomePage } from "./pages/HomePage";
import { AlbumView } from "./pages/AlbumView";
import { PlaylistView } from "./pages/PlaylistView";
import { SearchResultsPage } from "./pages/SearchResultsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LyricsView } from "./pages/LyricsView";
import { SearchOverlay } from "./components/SearchOverlay";
import { TrackContextMenuProvider } from "./components/TrackContextMenu";
import { TitleBar } from "./components/TitleBar";
import { PlayerBar } from "./components/player/PlayerBar";
import { Layout } from "./components/Layout";
import { Tab } from "./types/tab";
import { hasPrimaryModifierOnly } from "./platform";
import {
  libraryController,
  playerController,
  searchController,
  tabManager,
  useLibraryState,
  usePlayerState,
} from "../player/playerStore";
import styles from "./App.module.css";
import { loadAppSession, saveAppSession } from "../player/appSession";
import { useMediaSession } from "../player/useMediaSession";
import { playerUIStore, usePlayerUIState } from "./stores/playerUIStore";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import {
  Onboarding,
  OnboardingCompleteToast,
  KeychainNotice,
  OnboardingWelcome,
  type OnboardingStep,
} from "./components/Onboarding";
import { isMacOS } from "./platform";

const restoredSession = loadAppSession();
const LOADING_SCREEN_FADE_MS = 80;
const ONBOARDING_COMPLETE_KEY = "yt-music-dock:onboarding-complete";
const KEYCHAIN_NOTICE_COMPLETE_KEY = "yt-music-dock:keychain-notice-complete";
const LOADING_SCREEN_MIN_MS = 1000;

export default function App() {
  useDisableContextMenu();
  const libraryState = useLibraryState();
  const playerState = usePlayerState();
  const playerUIState = usePlayerUIState();

  const [tabs, setTabs] = useState<Tab[]>(
    () => restoredSession?.tabs ?? [{ id: "1", view: "home" }],
  );
  const [activeTabId, setActiveTabId] = useState(
    () => restoredSession?.activeTabId ?? "1",
  );
  const [nextTabId, setNextTabId] = useState(
    () => restoredSession?.nextTabId ?? 2,
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [loadingScreenState, setLoadingScreenState] = useState<"visible" | "leaving" | "hidden">("visible");
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(() =>
    localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true" ? null : "open-search"
  );
  const [onboardingFirstTabId, setOnboardingFirstTabId] = useState(activeTabId);
  const [onboardingSecondTabId, setOnboardingSecondTabId] = useState<string | null>(null);
  const [, setOnboardingSearchQuery] = useState("");
  const [showOnboardingComplete, setShowOnboardingComplete] = useState(false);
  const [showKeychainNotice, setShowKeychainNotice] = useState(
    () => isMacOS && localStorage.getItem(KEYCHAIN_NOTICE_COMPLETE_KEY) !== "true"
  );
  const [showOnboardingWelcome, setShowOnboardingWelcome] = useState(
    () => localStorage.getItem(ONBOARDING_COMPLETE_KEY) !== "true"
  );
  const loadingScreenDismissedRef = useRef(false);
  const loadingScreenStartedAtRef = useRef(performance.now());
  const sessionStateRef = useRef({ tabs, activeTabId, nextTabId });
  sessionStateRef.current = { tabs, activeTabId, nextTabId };

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  useMediaSession(playerState, playerController);
  const activeViewKey = [
    activeTabId,
    activeTab?.view,
    activeTab?.album?.id,
    activeTab?.playlist?.id,
    activeTab?.searchQuery,
  ].filter(Boolean).join(":");

  const handleNavigateHome = () => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === activeTabId
          ? { ...tab, view: "home", album: undefined, playlist: undefined }
          : tab
      )
    );
  };

  useEffect(() => {
    if (showKeychainNotice) return;
    void libraryController.initialize();
  }, [showKeychainNotice]);

  useEffect(() => {
    const hasRenderableLibrary = Boolean(libraryState.library);
    if (
      !hasRenderableLibrary
      && (libraryState.status === "restoring" || libraryState.status === "loading")
    ) {
      return;
    }

    let cancelled = false;
    let fadeTimer: number | undefined;

    const finishStartup = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled || loadingScreenDismissedRef.current) return;

      const elapsed = performance.now() - loadingScreenStartedAtRef.current;
      const remainingMinimum = Math.max(0, LOADING_SCREEN_MIN_MS - elapsed);
      fadeTimer = window.setTimeout(() => {
        if (cancelled || loadingScreenDismissedRef.current) return;

        loadingScreenDismissedRef.current = true;
        setLoadingScreenState("leaving");
        window.setTimeout(() => {
          setLoadingScreenState("hidden");
        }, LOADING_SCREEN_FADE_MS);
      }, remainingMinimum);
    };

    void finishStartup();
    return () => {
      cancelled = true;
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
    };
  }, [libraryState.library, libraryState.status]);

  useEffect(() => {
    const persist = () => {
      const current = sessionStateRef.current;
      saveAppSession({
        version: 1,
        tabs: current.tabs.map((tab) => ({
          ...tab,
          searchLoading: false,
        })),
        activeTabId: current.activeTabId,
        nextTabId: current.nextTabId,
        player: tabManager.exportSession(),
      });
    };

    const intervalId = window.setInterval(persist, 1000);
    window.addEventListener("beforeunload", persist);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("beforeunload", persist);
      persist();
    };
  }, []);

  useEffect(() => {
    const tabId = tabManager.getActivePlayerId();
    if (!tabId) return;

    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === tabId && tab.view !== "settings"
          ? { ...tab, title: playerState.currentTrack?.title }
          : tab
      )
    );
  }, [playerState.currentTrack, playerState.status]);

  useEffect(() => {
    if (!playerState.currentTrack && playerUIState.isLyricsOpen) {
      playerUIStore.setLyricsOpen(false);
    }
  }, [playerState.currentTrack, playerUIState.isLyricsOpen]);

  const handleNavigateAlbum = (album: Album) => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === activeTabId
          ? { ...tab, view: "album", album, playlist: undefined }
          : tab
      )
    );
  };

  const handleConnectionRestored = async () => {
    await libraryController.recoverConnection();
  };

  const handleNavigatePlaylist = (playlist: Playlist) => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === activeTabId
          ? { ...tab, view: "playlist", playlist, album: undefined }
          : tab
      )
    );
  };

  const createTab = () => {
    playerUIStore.setLyricsOpen(false);
    const newId = nextTabId.toString();
    tabManager.createTab(newId);
    void tabManager.setActive(newId);
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "home" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
    if (onboardingStep === "new-tab") {
      setOnboardingSecondTabId(newId);
      setOnboardingSearchQuery("");
      setOnboardingStep("type-second");
      setIsSearchOpen(true);
    }
  };

  const handleCreateTab = () => createTab();

  const handleSignIn = async () => {
    await libraryController.signIn();
    if (libraryController.getState().status !== "ready") return;

    playerUIStore.setLyricsOpen(false);
    const newId = nextTabId.toString();
    tabManager.createTab(newId);
    await tabManager.setActive(newId);
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "home" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const createTabFromShortcut = () => {
    createTab();
    setIsSearchOpen(true);
  };

  const handleSearch = (query: string, openInNewTab: boolean) => {
    playerUIStore.setLyricsOpen(false);
    let targetTabId = activeTabId;

    if (openInNewTab) {
      targetTabId = nextTabId.toString();
      tabManager.createTab(targetTabId);
      void tabManager.setActive(targetTabId);
      setTabs((prevTabs) => [
        ...prevTabs,
        {
          id: targetTabId,
          view: "search",
          title: query,
          searchQuery: query,
          searchResults: [],
          searchLoading: true,
        },
      ]);
      setActiveTabId(targetTabId);
      setNextTabId((currentId) => currentId + 1);
    } else {
      setTabs((prevTabs) =>
        prevTabs.map((tab) =>
          tab.id === targetTabId
            ? {
                ...tab,
                view: "search",
                title: query,
                album: undefined,
                playlist: undefined,
                searchQuery: query,
                searchResults: [],
                searchLoading: true,
              }
            : tab
        )
      );
    }

    const searchTabId = targetTabId;
    if (onboardingStep === "type-first") setOnboardingStep("play-first");
    if (onboardingStep === "type-second") setOnboardingStep("play-second");
    const applySearchResults = (tracks: Track[]) => {
      setTabs((prevTabs) =>
        prevTabs.map((tab) =>
          tab.id === searchTabId && tab.searchQuery === query
            ? {
                ...tab,
                view: "search",
                title: query,
                album: undefined,
                playlist: undefined,
                searchQuery: query,
                searchResults: tracks,
                searchLoading: false,
              }
            : tab
        )
      );
    };

    void searchController.searchTracks(query, applySearchResults)
      .then(applySearchResults)
      .catch(() => {
        setTabs((prevTabs) =>
          prevTabs.map((tab) =>
            tab.id === searchTabId && tab.searchQuery === query
              ? {
                  ...tab,
                  view: "search",
                  title: query,
                  album: undefined,
                  playlist: undefined,
                  searchQuery: query,
                  searchResults: [],
                  searchLoading: false,
                }
              : tab
          )
        );
      });
  };

  const handleOpenSettings = () => {
    playerUIStore.setLyricsOpen(false);
    const settingsTab = tabs.find((tab) => tab.view === "settings");
    if (settingsTab) {
      setActiveTabId(settingsTab.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "settings" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleCloseTab = (tabId: string) => {
    playerUIStore.setLyricsOpen(false);
    if (tabs.length === 1) return;

    const closedTab = tabs.find((tab) => tab.id === tabId);
    if (!closedTab) return;

    const newTabs = tabs.filter((tab) => tab.id !== tabId);
    const remainingMusicTabs = newTabs.filter((tab) => tab.view !== "settings");

    if (closedTab.view !== "settings" && remainingMusicTabs.length === 0) {
      return;
    }

    const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
    const replacementMusicTab =
      tabs
        .slice(0, closedIndex)
        .reverse()
        .find((tab) => tab.id !== tabId && tab.view !== "settings") ??
      tabs
        .slice(closedIndex + 1)
        .find((tab) => tab.view !== "settings");

    if (closedTab.view !== "settings" && tabManager.getActiveId() === tabId) {
      if (replacementMusicTab) {
        void tabManager.setActive(replacementMusicTab.id);
      }
    }

    if (activeTabId === tabId) {
      const playingTabId = tabManager.getActiveId();
      const playingTab = newTabs.find((tab) => tab.id === playingTabId);

      if (closedTab.view === "settings" && playingTab) {
        setActiveTabId(playingTab.id);
      } else {
        const nextTab = replacementMusicTab ?? newTabs[Math.max(0, closedIndex - 1)];
        if (nextTab.view !== "settings" && tabManager.getActiveId() !== nextTab.id) {
          void tabManager.setActive(nextTab.id);
        }
        setActiveTabId(nextTab.id);
      }
    }

    if (closedTab.view !== "settings") {
      tabManager.removeTab(tabId);
    }
    setTabs(newTabs);
  };

  const handleSwitchTab = (tabId: string) => {
    playerUIStore.setLyricsOpen(false);
    const tab = tabs.find((item) => item.id === tabId);
    if (tab?.view !== "settings") {
      void tabManager.setActive(tabId);
    }
    setActiveTabId(tabId);
    if (onboardingStep === "switch-back" && tabId === onboardingFirstTabId) {
      localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
      setOnboardingStep(null);
      setShowOnboardingComplete(true);
    }
  };

  const finishOnboarding = () => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setOnboardingStep(null);
  };

  const handlePlaySearchTrack = async (track: Track) => {
    const stepAtStart = onboardingStep;
    const tabAtStart = activeTabId;
    const started = await playerController.playTrackById(track.id, [track], true);
    if (!started) return;

    if (
      (stepAtStart === "type-first" || stepAtStart === "play-first")
      && tabAtStart === onboardingFirstTabId
    ) {
      setOnboardingStep("new-tab");
      setIsSearchOpen(false);
    }
    if (
      (stepAtStart === "type-second" || stepAtStart === "play-second")
      && tabAtStart === onboardingSecondTabId
    ) {
      setOnboardingStep("switch-back");
      setIsSearchOpen(false);
    }
  };

  const handlePlaySearchResult = async (track: Track) => {
    const stepAtStart = onboardingStep;
    const tabAtStart = activeTabId;
    const started = await playerController.playTrackById(track.id, [track], true);
    if (!started) return;

    if (stepAtStart === "play-first" && tabAtStart === onboardingFirstTabId) {
      setOnboardingStep("new-tab");
    }
    if (stepAtStart === "play-second" && tabAtStart === onboardingSecondTabId) {
      setOnboardingStep("switch-back");
    }
  };

  const dismissSearch = () => {
    setIsSearchOpen(false);
    if (
      onboardingStep === "type-first"
      || onboardingStep === "play-first"
      || onboardingStep === "type-second"
      || onboardingStep === "play-second"
    ) {
      setOnboardingSearchQuery("");
      setOnboardingStep("open-search");
    }
  };

  const restartOnboarding = () => {
    const firstMusicTab = tabs.find((tab) => tab.view !== "settings");
    if (!firstMusicTab) return;
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    setOnboardingFirstTabId(firstMusicTab.id);
    setOnboardingSecondTabId(null);
    setOnboardingSearchQuery("");
    setOnboardingStep("open-search");
    handleSwitchTab(firstMusicTab.id);
  };

  useEffect(() => {
    if (onboardingStep === "open-search" && isSearchOpen) {
      setOnboardingSearchQuery("");
      setOnboardingStep(
        onboardingSecondTabId && activeTabId === onboardingSecondTabId
          ? "type-second"
          : "type-first"
      );
    }
  }, [activeTabId, isSearchOpen, onboardingSecondTabId, onboardingStep]);

  useEffect(() => {
    if (!showOnboardingComplete) return;
    const timer = window.setTimeout(() => setShowOnboardingComplete(false), 3400);
    return () => window.clearTimeout(timer);
  }, [showOnboardingComplete]);

  useEffect(() => {
    if (!showOnboardingWelcome || loadingScreenState !== "hidden") return;
    const timer = window.setTimeout(() => setShowOnboardingWelcome(false), 2600);
    return () => window.clearTimeout(timer);
  }, [loadingScreenState, showOnboardingWelcome]);

  const handleToggleLyrics = () => {
    if (playerUIState.isLyricsOpen) {
      playerUIStore.setLyricsOpen(false);
      return;
    }

    const playbackTabId = tabManager.getPlaybackOwnerId();
    if (playbackTabId && playbackTabId !== activeTabId) {
      const playbackTab = tabs.find((tab) => tab.id === playbackTabId);
      if (playbackTab) {
        void tabManager.setActive(playbackTabId);
        setActiveTabId(playbackTabId);
      }
    }
    playerUIStore.setLyricsOpen(true);
  };

  const handleKeychainNoticeContinue = () => {
    localStorage.setItem(KEYCHAIN_NOTICE_COMPLETE_KEY, "true");
    setShowKeychainNotice(false);
  };

  const handleReorderTab = (
    draggedTabId: string,
    targetTabId: string,
    insertAfter: boolean,
  ) => {
    setTabs((currentTabs) => {
      const draggedIndex = currentTabs.findIndex((tab) => tab.id === draggedTabId);
      const targetIndex = currentTabs.findIndex((tab) => tab.id === targetTabId);
      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return currentTabs;
      }

      const nextTabs = [...currentTabs];
      const [draggedTab] = nextTabs.splice(draggedIndex, 1);
      const adjustedTargetIndex = nextTabs.findIndex((tab) => tab.id === targetTabId);
      nextTabs.splice(adjustedTargetIndex + (insertAfter ? 1 : 0), 0, draggedTab);
      return nextTabs;
    });
  };

  useEffect(() => {
    const isTextEntry = (target: EventTarget | null) => {
      return target instanceof Element
        && target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) !== null;
    };

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const primaryModifierOnly = hasPrimaryModifierOnly(event);

      if (primaryModifierOnly && event.code === "Space" && activeTab?.view !== "settings") {
        event.preventDefault();
        if (isSearchOpen) dismissSearch();
        else setIsSearchOpen(true);
        return;
      }

      if (primaryModifierOnly && event.code === "KeyT") {
        event.preventDefault();
        createTabFromShortcut();
        return;
      }

      if (primaryModifierOnly && event.code === "KeyW") {
        event.preventDefault();
        handleCloseTab(activeTabId);
        return;
      }

      if (primaryModifierOnly && /^Digit[1-9]$/.test(event.code)) {
        const tabIndex = Number(event.code.slice(-1)) - 1;
        const tab = tabs[tabIndex];
        if (tab) {
          event.preventDefault();
          handleSwitchTab(tab.id);
        }
        return;
      }

      if (
        event.code === "Space"
        && !event.ctrlKey
        && !event.altKey
        && !event.metaKey
        && !event.shiftKey
        && !event.defaultPrevented
        && !isTextEntry(event.target)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        if (event.target instanceof HTMLElement) {
          event.target.blur();
        }
        void playerController.togglePlayPause();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    activeTab?.view,
    activeTabId,
    isSearchOpen,
    nextTabId,
    onboardingStep,
    playerState.currentTrack,
    playerState.status,
    tabs,
  ]);

  return (
    <TrackContextMenuProvider libraryController={libraryController}>
    <div className={styles.root}>
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        playingTabId={
          playerState.status === "playing"
            ? tabManager.getActivePlayerId()
            : null
        }
        sidebarWidth={sidebarWidth}
        isHomeActive={activeTab?.view === "home"}
        onNavigateHome={handleNavigateHome}
        onCreateTab={handleCreateTab}
        onCloseTab={handleCloseTab}
        onSwitchTab={handleSwitchTab}
        onReorderTab={handleReorderTab}
        onboardingFirstTabId={onboardingStep ? onboardingFirstTabId : undefined}
      />
      <div className={styles.content}>
        <Layout
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={setSidebarWidth}
          onNavigateAlbum={handleNavigateAlbum}
          onNavigatePlaylist={handleNavigatePlaylist}
          onOpenSettings={handleOpenSettings}
          showSearchBar={activeTab?.view !== "settings" && !playerUIState.isLyricsOpen}
          onOpenSearch={() => setIsSearchOpen(true)}
          fullBleedContent={playerUIState.isLyricsOpen}
        >
          {playerUIState.isLyricsOpen && activeTab?.view !== "settings" ? (
            <LyricsView onClose={() => playerUIStore.setLyricsOpen(false)} />
          ) : (
          <div key={activeViewKey} className={styles.viewTransition}>
            {activeTab?.view === "home" && (
              <HomePage
                tabId={activeTabId}
                playerController={playerController}
                libraryController={libraryController}
                libraryState={libraryState}
                searchController={searchController}
                onSignIn={handleSignIn}
              />
            )}
            {activeTab?.view === "album" && (
              <AlbumView
                album={activeTab?.album}
                playerController={playerController}
                libraryController={libraryController}
              />
            )}
            {activeTab?.view === "playlist" && (
              <PlaylistView
                playlist={activeTab.playlist}
                playerController={playerController}
                libraryController={libraryController}
              />
            )}
            {activeTab?.view === "search" && (
                <SearchResultsPage
                query={activeTab.searchQuery ?? ""}
                tracks={activeTab.searchResults ?? []}
                isLoading={activeTab.searchLoading ?? false}
                  playerController={playerController}
                    onPlayTrack={handlePlaySearchResult}
                />
            )}
            {activeTab?.view === "settings" && (
              <SettingsPage
                libraryController={libraryController}
                libraryState={libraryState}
                onRestartOnboarding={restartOnboarding}
                onSignIn={handleSignIn}
              />
            )}
          </div>
          )}
        </Layout>
      </div>
      <PlayerBar
        onToggleLyrics={handleToggleLyrics}
        onConnectionRestored={handleConnectionRestored}
      />
      <SearchOverlay
        isOpen={isSearchOpen && activeTab?.view !== "settings"}
        activeTabId={activeTabId}
        searchController={searchController}
        albums={libraryState.library?.albums ?? []}
        playlists={libraryState.library?.playlists ?? []}
          onClose={() => setIsSearchOpen(false)}
          onDismiss={dismissSearch}
        onSubmit={handleSearch}
        onPlayTrack={(track) => void handlePlaySearchTrack(track)}
        onOpenAlbum={handleNavigateAlbum}
        onOpenPlaylist={handleNavigatePlaylist}
        onQueryChange={setOnboardingSearchQuery}
      />
      {loadingScreenState !== "hidden" && (
        <AppLoadingScreen isLeaving={loadingScreenState === "leaving"} />
      )}
        {showKeychainNotice && (
          <KeychainNotice onContinue={handleKeychainNoticeContinue} />
        )}
        {loadingScreenState === "hidden" && showOnboardingWelcome && (
          <OnboardingWelcome />
        )}
        {loadingScreenState === "hidden" && !showOnboardingWelcome && onboardingStep && (
          <Onboarding step={onboardingStep} onSkip={finishOnboarding} />
        )}
        {showOnboardingComplete && <OnboardingCompleteToast />}
    </div>
    </TrackContextMenuProvider>
  );
}

