import { useSyncExternalStore } from "react";
import { logInternalDebug } from "../internal/logging";
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
  | "removeFromQueueAt"
  | "playQueueTrackAt"
  | "moveQueueTrack";

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
  setVolume = async (level: number) => {
    const player = tabManager.getActivePlayer();
    const volume = Math.min(1, Math.max(0, level));
    logInternalDebug("ActivePlayerController.setVolume", {
      requestedLevel: level,
      clampedVolume: volume,
      activeId: tabManager.getActiveId(),
      activePlayerId: tabManager.getActivePlayerId(),
      playbackOwnerId: tabManager.getPlaybackOwnerId(),
      targetStatus: player.getState().status,
      targetTrackId: player.getState().currentTrack?.id ?? null,
      beforeVolume: player.getVolume(),
      beforeMuted: player.isMuted(),
    });
    await player.setVolume(volume, volume === 0);
    logInternalDebug("ActivePlayerController.setVolume applied", {
      activeId: tabManager.getActiveId(),
      activePlayerId: tabManager.getActivePlayerId(),
      playbackOwnerId: tabManager.getPlaybackOwnerId(),
      afterVolume: player.getVolume(),
      afterMuted: player.isMuted(),
    });
    tabManager.applyPlaybackSettings({
      volume: player.getVolume(),
      muted: player.isMuted(),
    });
  };
  skipToPrevious = () => tabManager.getActivePlayer().skipToPrevious();
  getCurrentTime = () => tabManager.getActivePlayer().getCurrentTime();
  getDuration = () => tabManager.getActivePlayer().getDuration();
  getVolume = () => tabManager.getActivePlayer().getVolume();
  isMuted = () => tabManager.getActivePlayer().isMuted();
  toggleMute = async () => {
    const player = tabManager.getActivePlayer();
    await player.toggleMute();
    tabManager.applyPlaybackSettings({
      volume: player.getVolume(),
      muted: player.isMuted(),
    });
  };
  getPlaybackOrderMode = () => tabManager.getActivePlayer().getPlaybackOrderMode();
  cyclePlaybackOrderMode = () => tabManager.getActivePlayer().cyclePlaybackOrderMode();
  getLyrics = (track: Parameters<PlayerController["getLyrics"]>[0]) =>
    tabManager.getActivePlayer().getLyrics(track);
  getPlayerSession = () => tabManager.getActivePlayer().exportSession();
  removeFromQueueAt = (index: number) => tabManager.getActivePlayer().removeFromQueueAt(index);
  playQueueTrackAt = (index: number) => tabManager.getActivePlayer().playQueueTrackAt(index);
  moveQueueTrack = (
    sourceIndex: number,
    targetIndex: number,
    insertAfter: boolean,
  ) => tabManager.getActivePlayer().moveQueueTrack(sourceIndex, targetIndex, insertAfter);
}

export const playerController: PlayerControllerActions = new ActivePlayerController();

export function resolveDownloadStream(track: Parameters<YouTubeMusicDataSource["resolveDownloadStream"]>[0], quality: Parameters<YouTubeMusicDataSource["resolveDownloadStream"]>[1]) {
  return dataSource.resolveDownloadStream(track, quality);
}

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
