import { useSyncExternalStore } from "react";
import { YouTubeMusicDataSource } from "../datasource/youtube/YouTubeMusicDataSource";
import { LibraryController } from "./LibraryController";
import { PlayerController } from "./PlayerController";
import { SearchController } from "./SearchController";
import { TabManager } from "./TabManager";
import { loadAppSession } from "./appSession";

const dataSource = new YouTubeMusicDataSource();

export const libraryController = new LibraryController(dataSource);
export const searchController = new SearchController(dataSource);
export const tabManager = new TabManager(dataSource);
const restoredSession = loadAppSession();
if (restoredSession) {
  tabManager.restoreSession(restoredSession.player);
}
if (!tabManager.getActiveId()) {
  tabManager.createTab("1");
}

type PlayerControllerMethod =
  | "loadTrack"
  | "playTrackById"
  | "play"
  | "pause"
  | "togglePlayPause"
  | "addToQueue"
  | "playNext"
  | "skipToNext"
  | "seekTo"
  | "setVolume"
  | "skipToPrevious"
  | "getCurrentTime"
  | "getDuration"
  | "getVolume"
  | "isMuted"
  | "toggleMute"
  | "getPlaybackOrderMode"
  | "cyclePlaybackOrderMode"
  | "getLyrics"
  | "getPlayerSession"
  | "removeFromQueueAt";

export type PlayerControllerActions = Pick<PlayerController, PlayerControllerMethod>;

class ActivePlayerController implements PlayerControllerActions {
  loadTrack = async (track: Parameters<PlayerController["loadTrack"]>[0]) =>
    (await tabManager.claimFocusedPlayer()).loadTrack(track);
  playTrackById = async (
    videoId: string,
    playbackQueue?: Parameters<PlayerController["playTrackById"]>[1],
    autoplayWhenQueueEnds?: Parameters<PlayerController["playTrackById"]>[2],
  ) => (await tabManager.claimFocusedPlayer()).playTrackById(
    videoId,
    playbackQueue,
    autoplayWhenQueueEnds,
  );
  play = () => tabManager.getActivePlayer().play();
  pause = () => tabManager.getActivePlayer().pause();
  togglePlayPause = () => tabManager.getActivePlayer().togglePlayPause();
  addToQueue = (track: Parameters<PlayerController["addToQueue"]>[0]) =>
    tabManager.getActivePlayer().addToQueue(track);
  playNext = (track: Parameters<PlayerController["playNext"]>[0]) =>
    tabManager.getActivePlayer().playNext(track);
  skipToNext = () => tabManager.getActivePlayer().skipToNext();
  seekTo = (time: number) => tabManager.getActivePlayer().seekTo(time);
  setVolume = (level: number) => tabManager.getActivePlayer().setVolume(level);
  skipToPrevious = () => tabManager.getActivePlayer().skipToPrevious();
  getCurrentTime = () => tabManager.getActivePlayer().getCurrentTime();
  getDuration = () => tabManager.getActivePlayer().getDuration();
  getVolume = () => tabManager.getActivePlayer().getVolume();
  isMuted = () => tabManager.getActivePlayer().isMuted();
  toggleMute = () => tabManager.getActivePlayer().toggleMute();
  getPlaybackOrderMode = () => tabManager.getActivePlayer().getPlaybackOrderMode();
  cyclePlaybackOrderMode = () => tabManager.getActivePlayer().cyclePlaybackOrderMode();
  getLyrics = (track: Parameters<PlayerController["getLyrics"]>[0]) =>
    tabManager.getActivePlayer().getLyrics(track);
  getPlayerSession = () => tabManager.getActivePlayer().exportSession();
  removeFromQueueAt = (index: number) => tabManager.getActivePlayer().removeFromQueueAt(index);
}

export const playerController: PlayerControllerActions = new ActivePlayerController();

export function usePlayerState() {
  return useSyncExternalStore(
    (listener) => tabManager.subscribe(listener),
    () => tabManager.getActiveState(),
    () => tabManager.getActiveState(),
  );
}

export function usePlayerSession() {
  return useSyncExternalStore(
    (listener) => tabManager.subscribe(listener),
    () => tabManager.getActiveSession(),
    () => tabManager.getActiveSession(),
  );
}

export function useLibraryState() {
  return useSyncExternalStore(
    (listener) => libraryController.subscribe(listener),
    () => libraryController.getState(),
    () => libraryController.getState(),
  );
}
