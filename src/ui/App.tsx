import { useCallback, useEffect, useRef, useState } from "react";
import type { Album, Artist, Playlist, SearchResults, Track } from "../datasource/types";
import { useDisableContextMenu } from "./hooks/useDisableContextMenu";
import { HomePage } from "./pages/HomePage";
import { AlbumView } from "./pages/AlbumView";
import { PlaylistView } from "./pages/PlaylistView";
import { SearchResultsPage } from "./pages/SearchResultsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LyricsView } from "./pages/LyricsView";
import { ArtistView } from "./pages/ArtistView";
import { SearchOverlay } from "./components/SearchOverlay";
import { TrackContextMenuProvider } from "./components/TrackContextMenu";
import { PlaylistContextMenuProvider } from "./components/PlaylistContextMenu";
import { ArtistNavigationProvider } from "./components/ArtistLinks";
import { TitleBar } from "./components/TitleBar";
import { PlayerBar } from "./components/player/PlayerBar";
import { QueuePanel } from "./components/player/QueuePanel";
import { Layout } from "./components/Layout";
import type { Tab, TabViewState } from "./types/tab";
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
import { UpdateToast } from "./components/UpdateToast";
import {
  checkForUpdates,
  isUpdateSnoozed,
  type UpdateInfo,
} from "../internal/updateChecker";
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
const MOUSE_BACK_BUTTON = 3;
const MOUSE_FORWARD_BUTTON = 4;

function getNavigationState(tab: Tab): TabViewState | null {
  if (tab.view === "settings") return null;

  return {
    title: tab.title,
    view: tab.view,
    album: tab.album,
    artist: tab.artist,
    playlist: tab.playlist,
    searchQuery: tab.searchQuery,
    searchResults: tab.searchResults,
    mixedSearchResults: tab.mixedSearchResults,
    searchLoading: tab.searchLoading,
  };
}

function getNavigationKey(state: TabViewState): string {
  switch (state.view) {
    case "album":
      return `album:${state.album?.id ?? ""}`;
    case "artist":
      return `artist:${state.artist?.id ?? state.artist?.name ?? ""}`;
    case "playlist":
      return `playlist:${state.playlist?.id ?? ""}`;
    case "search":
      return `search:${state.searchQuery ?? ""}`;
    case "home":
      return "home";
  }
}

function applyNavigationState(tab: Tab, state: TabViewState): Tab {
  return {
    ...tab,
    title: state.title,
    view: state.view,
    album: state.album,
    artist: state.artist,
    playlist: state.playlist,
    searchQuery: state.searchQuery,
    searchResults: state.searchResults,
    mixedSearchResults: state.mixedSearchResults,
    searchLoading: state.searchLoading,
  };
}

function stripNavigationHistory(tab: Tab): Tab {
  const { navigationHistory, ...sessionTab } = tab;
  void navigationHistory;
  return sessionTab;
}

export default function App() {
  useDisableContextMenu();
  const libraryState = useLibraryState();
  const playerState = usePlayerState();
  const playerUIState = usePlayerUIState();

  const [tabs, setTabs] = useState<Tab[]>(
    () => restoredSession?.tabs.map(stripNavigationHistory) ?? [{ id: "1", view: "home" }],
  );
  const [activeTabId, setActiveTabId] = useState(
    () => restoredSession?.activeTabId ?? "1",
  );
  const [nextTabId, setNextTabId] = useState(
    () => restoredSession?.nextTabId ?? 2,
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [queuePanelWidth, setQueuePanelWidth] = useState(340);
  const [loadingScreenState, setLoadingScreenState] = useState<"visible" | "leaving" | "hidden">("visible");
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(() =>
    localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true" ? null : "open-search"
  );
  const [showQueueMounted, setShowQueueMounted] = useState(false);
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
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const dismissAvailableUpdate = useCallback(() => {
    setAvailableUpdate(null);
  }, []);
  const loadingScreenDismissedRef = useRef(false);
  const loadingScreenStartedAtRef = useRef(performance.now());
  const sessionStateRef = useRef({ tabs, activeTabId, nextTabId });
  sessionStateRef.current = { tabs, activeTabId, nextTabId };

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isQueuePanelOpen = activeTab?.isQueueOpen ?? false;
  const canNavigateBack = (activeTab?.navigationHistory?.back.length ?? 0) > 0;
  const canNavigateForward = (activeTab?.navigationHistory?.forward.length ?? 0) > 0;

  const navigateTab = useCallback((tabId: string, nextState: TabViewState) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const currentState = getNavigationState(tab);
        if (!currentState) return applyNavigationState(tab, nextState);

        const nextTab = applyNavigationState(tab, nextState);
        if (getNavigationKey(currentState) === getNavigationKey(nextState)) {
          return nextTab;
        }

        return {
          ...nextTab,
          navigationHistory: {
            back: [...(tab.navigationHistory?.back ?? []), currentState],
            forward: [],
          },
        };
      })
    );
  }, []);

  const updateSearchTab = useCallback((tabId: string, query: string, nextState: TabViewState) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== tabId) return tab;

        const updateHistoryState = (state: TabViewState) =>
          state.view === "search" && state.searchQuery === query
            ? nextState
            : state;
        const navigationHistory = tab.navigationHistory
          ? {
              back: tab.navigationHistory.back.map(updateHistoryState),
              forward: tab.navigationHistory.forward.map(updateHistoryState),
            }
          : undefined;

        if (tab.searchQuery !== query) {
          return {
            ...tab,
            navigationHistory,
          };
        }

        return {
          ...applyNavigationState(tab, nextState),
          navigationHistory,
        };
      })
    );
  }, []);

  const handleNavigateBack = useCallback(() => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== activeTabId) return tab;

        const currentState = getNavigationState(tab);
        const back = tab.navigationHistory?.back ?? [];
        if (!currentState || back.length === 0) return tab;

        const previousState = back[back.length - 1];
        const nextTab = applyNavigationState(tab, previousState);
        return {
          ...nextTab,
          navigationHistory: {
            back: back.slice(0, -1),
            forward: [currentState, ...(tab.navigationHistory?.forward ?? [])],
          },
        };
      })
    );
  }, [activeTabId]);

  const handleNavigateForward = useCallback(() => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== activeTabId) return tab;

        const currentState = getNavigationState(tab);
        const forward = tab.navigationHistory?.forward ?? [];
        if (!currentState || forward.length === 0) return tab;

        const nextState = forward[0];
        const nextTab = applyNavigationState(tab, nextState);
        return {
          ...nextTab,
          navigationHistory: {
            back: [...(tab.navigationHistory?.back ?? []), currentState],
            forward: forward.slice(1),
          },
        };
      })
    );
  }, [activeTabId]);

  const setIsQueuePanelOpen = useCallback(
    (open: boolean) => {
      setTabs((prevTabs) =>
        prevTabs.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, isQueueOpen: open }
            : tab
        )
      );
    },
    [activeTabId],
  );

  useMediaSession(playerState, playerController);
  const activeViewKey = [
    activeTabId,
    activeTab?.view,
    activeTab?.album?.id,
    activeTab?.artist?.id,
    activeTab?.playlist?.id,
    activeTab?.searchQuery,
  ].filter(Boolean).join(":");

  const handleNavigateHome = () => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "home",
    });
  };

  useEffect(() => {
    if (showKeychainNotice) return;
    void libraryController.initialize();
  }, [showKeychainNotice]);

  useEffect(() => {
    if (showKeychainNotice) {
      loadingScreenDismissedRef.current = true;
      setLoadingScreenState("hidden");
      return;
    }

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
  }, [libraryState.library, libraryState.status, showKeychainNotice]);

  useEffect(() => {
    const persist = () => {
      const current = sessionStateRef.current;
      saveAppSession({
        version: 1,
        tabs: current.tabs.map((tab) => ({
          ...stripNavigationHistory(tab),
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
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "album",
      album,
    });
  };

  const handleNavigateArtist = (artist: Artist, openInNewTab = false) => {
    playerUIStore.setLyricsOpen(false);
    if (!artist.id) {
      const fallbackToSearch = () => handleSearch(artist.name, openInNewTab);
      void searchController.search(artist.name)
        .then((results) => {
          const normalizedName = artist.name.trim().toLocaleLowerCase();
          const resolved = results.artists.find(
            (candidate) => candidate.name.trim().toLocaleLowerCase() === normalizedName,
          ) ?? results.artists.find((candidate) => {
            const candidateName = candidate.name.trim().toLocaleLowerCase();
            return candidateName.includes(normalizedName)
              || normalizedName.includes(candidateName);
          }) ?? results.artists[0];

          if (resolved) {
            handleNavigateArtist(resolved, openInNewTab);
            return;
          }

          fallbackToSearch();
        })
        .catch(fallbackToSearch);
      return;
    }
    if (openInNewTab) {
      const newId = nextTabId.toString();
      tabManager.createTab(newId);
      void tabManager.setActive(newId);
      setTabs((prevTabs) => [
        ...prevTabs,
        { id: newId, view: "artist", artist, title: artist.name },
      ]);
      setActiveTabId(newId);
      setNextTabId((currentId) => currentId + 1);
      return;
    }

    navigateTab(activeTabId, {
      view: "artist",
      artist,
      title: artist.name,
    });
  };

  const handleConnectionRestored = async () => {
    await libraryController.recoverConnection();
  };

  const handleNavigatePlaylist = (playlist: Playlist) => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "playlist",
      playlist,
    });
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
          mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
          searchLoading: true,
        },
      ]);
      setActiveTabId(targetTabId);
      setNextTabId((currentId) => currentId + 1);
    } else {
      navigateTab(targetTabId, {
        view: "search",
        title: query,
        searchQuery: query,
        searchResults: [],
        mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
        searchLoading: true,
      });
    }

    const searchTabId = targetTabId;
    if (onboardingStep === "type-first") setOnboardingStep("play-first");
    if (onboardingStep === "type-second") setOnboardingStep("play-second");
    const applySearchResults = (results: SearchResults) => {
      updateSearchTab(searchTabId, query, {
        view: "search",
        title: query,
        searchQuery: query,
        searchResults: results.tracks,
        mixedSearchResults: results,
        searchLoading: false,
      });
    };

    void searchController.search(query, applySearchResults)
      .then(applySearchResults)
      .catch(() => {
        updateSearchTab(searchTabId, query, {
          view: "search",
          title: query,
          searchQuery: query,
          searchResults: [],
          mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
          searchLoading: false,
        });
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

  useEffect(() => {
    if (
      loadingScreenState !== "hidden"
      || showKeychainNotice
      || showOnboardingWelcome
    ) {
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      void checkForUpdates()
        .then((update) => {
          if (
            active
            && update
            && !isUpdateSnoozed(update.version)
          ) {
            setAvailableUpdate(update);
          }
        })
        .catch(() => {
          // Startup update checks should not interrupt the app.
        });
    }, 3000);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadingScreenState, showKeychainNotice, showOnboardingWelcome]);

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

  const handleToggleQueue = () => {
    // Toggle asynchronously to avoid triggering synchronous store updates
    // during React commit phase which can cause "Maximum update depth".
    setTimeout(() => setIsQueuePanelOpen(!isQueuePanelOpen), 0);
  };

  useEffect(() => {
    if (isQueuePanelOpen) {
      // Mount the panel after commit to avoid nested update loops
      const id = window.setTimeout(() => setShowQueueMounted(true), 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => setShowQueueMounted(false), 200);
    return () => window.clearTimeout(id);
  }, [isQueuePanelOpen]);

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

    const handleMouseNavigation = (event: MouseEvent) => {
      if (
        event.button !== MOUSE_BACK_BUTTON
        && event.button !== MOUSE_FORWARD_BUTTON
      ) {
        return;
      }
      if (isTextEntry(event.target)) return;

      if (event.button === MOUSE_BACK_BUTTON) {
        if (isSearchOpen && activeTab?.view !== "settings") {
          event.preventDefault();
          setIsSearchOpen(false);
          return;
        }
        if (canNavigateBack) {
          event.preventDefault();
          handleNavigateBack();
        }
        return;
      }

      if (canNavigateForward) {
        event.preventDefault();
        handleNavigateForward();
      }
    };

    const preventAuxNavigation = (event: MouseEvent) => {
      if (
        event.button === MOUSE_BACK_BUTTON
        || event.button === MOUSE_FORWARD_BUTTON
      ) {
        event.preventDefault();
      }
    };

    window.addEventListener("mousedown", handleMouseNavigation);
    window.addEventListener("auxclick", preventAuxNavigation);
    return () => {
      window.removeEventListener("mousedown", handleMouseNavigation);
      window.removeEventListener("auxclick", preventAuxNavigation);
    };
  }, [
    activeTab?.view,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    isSearchOpen,
  ]);

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
    <ArtistNavigationProvider onNavigate={handleNavigateArtist}>
    <TrackContextMenuProvider libraryController={libraryController}>
    <PlaylistContextMenuProvider libraryController={libraryController}>
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
          canGoBack={canNavigateBack}
          canGoForward={canNavigateForward}
          onNavigateBack={handleNavigateBack}
          onNavigateForward={handleNavigateForward}
          fullBleedContent={playerUIState.isLyricsOpen}
          rightPanelWidth={queuePanelWidth}
          onRightPanelWidthChange={setQueuePanelWidth}
          rightPanel={showQueueMounted ? (
            <QueuePanel
              isOpen={isQueuePanelOpen}
              onClose={() => setIsQueuePanelOpen(false)}
            />
          ) : undefined}
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
            {activeTab?.view === "artist" && (
              <ArtistView
                artist={activeTab.artist}
                playerController={playerController}
                libraryController={libraryController}
                onOpenAlbum={handleNavigateAlbum}
                onOpenPlaylist={handleNavigatePlaylist}
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
                results={activeTab.mixedSearchResults ?? {
                  artists: [],
                  tracks: activeTab.searchResults ?? [],
                  albums: [],
                  playlists: [],
                }}
                isLoading={activeTab.searchLoading ?? false}
                  playerController={playerController}
                    onPlayTrack={handlePlaySearchResult}
                onOpenArtist={(artist) => handleNavigateArtist(artist)}
                onOpenAlbum={handleNavigateAlbum}
                onOpenPlaylist={handleNavigatePlaylist}
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
        onToggleQueue={handleToggleQueue}
        isQueueOpen={isQueuePanelOpen}
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
        onOpenArtist={(artist) => handleNavigateArtist(artist)}
        onOpenPlaylist={handleNavigatePlaylist}
        onQueryChange={setOnboardingSearchQuery}
      />
      {loadingScreenState !== "hidden" && (
        <AppLoadingScreen isLeaving={loadingScreenState === "leaving"} />
      )}
      {showKeychainNotice ? (
        <KeychainNotice onContinue={handleKeychainNoticeContinue} />
      ) : (
        <>
          {loadingScreenState === "hidden" && showOnboardingWelcome && (
            <OnboardingWelcome />
          )}
          {loadingScreenState === "hidden" && !showOnboardingWelcome && onboardingStep && (
            <Onboarding step={onboardingStep} onSkip={finishOnboarding} />
          )}
          {showOnboardingComplete && <OnboardingCompleteToast />}
        </>
      )}
      {availableUpdate && (
        <UpdateToast
          update={availableUpdate}
          onDismiss={dismissAvailableUpdate}
        />
      )}
    </div>
    </PlaylistContextMenuProvider>
    </TrackContextMenuProvider>
    </ArtistNavigationProvider>
  );
}
