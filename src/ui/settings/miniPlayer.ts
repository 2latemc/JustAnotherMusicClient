import { useSyncExternalStore } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  availableMonitors,
  currentMonitor,
  PhysicalPosition,
  primaryMonitor,
} from "@tauri-apps/api/window";
import {
  hydrateLocalBooleanSetting,
  hydrateLocalJsonSetting,
  readLocalBooleanSetting,
  readLocalJsonSetting,
  writeLocalBooleanSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";

const STORAGE_KEY = "mini-player-enabled";
const POSITION_STORAGE_KEY = "mini-player-position";
const CHANGE_EVENT = "mini-player-enabled-change";
const MINI_PLAYER_BOTTOM_MARGIN = 24;

export interface MiniPlayerPosition {
  x: number;
  y: number;
}

function isMiniPlayerPosition(value: unknown): value is MiniPlayerPosition {
  return (
    typeof value === "object"
    && value !== null
    && Number.isFinite((value as MiniPlayerPosition).x)
    && Number.isFinite((value as MiniPlayerPosition).y)
  );
}

function readMiniPlayerEnabled() {
  return readLocalBooleanSetting(STORAGE_KEY, true);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setMiniPlayerEnabled(enabled: boolean) {
  writeLocalBooleanSetting(STORAGE_KEY, enabled, CHANGE_EVENT);
}

export function getMiniPlayerEnabled() {
  return readMiniPlayerEnabled();
}

export function getSavedMiniPlayerPosition(): MiniPlayerPosition | null {
  return readLocalJsonSetting(POSITION_STORAGE_KEY, isMiniPlayerPosition);
}

export function saveMiniPlayerPosition(position: MiniPlayerPosition) {
  writeLocalJsonSetting(POSITION_STORAGE_KEY, position);
}

export async function hydrateMiniPlayerSettings() {
  await Promise.all([
    hydrateLocalBooleanSetting(STORAGE_KEY, true, CHANGE_EVENT),
    hydrateLocalJsonSetting(POSITION_STORAGE_KEY, isMiniPlayerPosition),
  ]);
}

export async function resetMiniPlayerPosition() {
  const miniWin = await WebviewWindow.getByLabel("mini-player");
  const monitor = await currentMonitor()
    ?? await primaryMonitor()
    ?? (await availableMonitors())[0];
  if (!miniWin || !monitor) return;

  const size = await miniWin.outerSize();
  const x = monitor.position.x + Math.round((monitor.size.width - size.width) / 2);
  const y = monitor.position.y + monitor.size.height - size.height - MINI_PLAYER_BOTTOM_MARGIN;

  await miniWin.setPosition(new PhysicalPosition(x, y));
  saveMiniPlayerPosition({ x, y });
}

export function useMiniPlayerEnabled() {
  return useSyncExternalStore(subscribe, readMiniPlayerEnabled, () => true);
}
