import { useSyncExternalStore } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, PhysicalPosition } from "@tauri-apps/api/window";

const STORAGE_KEY = "mini-player-enabled";
const POSITION_STORAGE_KEY = "mini-player-position";
const CHANGE_EVENT = "mini-player-enabled-change";
const MINI_PLAYER_BOTTOM_MARGIN = 24;

export interface MiniPlayerPosition {
  x: number;
  y: number;
}

function readMiniPlayerEnabled() {
  return localStorage.getItem(STORAGE_KEY) !== "false";
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
  localStorage.setItem(STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getMiniPlayerEnabled() {
  return readMiniPlayerEnabled();
}

export function getSavedMiniPlayerPosition(): MiniPlayerPosition | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) ?? "null") as MiniPlayerPosition | null;
    if (!parsed || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;

    return parsed;
  } catch {
    return null;
  }
}

export function saveMiniPlayerPosition(position: MiniPlayerPosition) {
  localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
}

export async function resetMiniPlayerPosition() {
  const miniWin = await WebviewWindow.getByLabel("mini-player");
  const monitor = await currentMonitor();
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
