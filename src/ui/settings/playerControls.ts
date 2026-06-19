import { useSyncExternalStore } from "react";

const EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY = "extra-player-controls-always-visible";
const CHANGE_EVENT = "player-controls-change";

function readExtraControlsAlwaysVisible() {
  return localStorage.getItem(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY) !== "false";
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setExtraPlayerControlsAlwaysVisible(enabled: boolean) {
  localStorage.setItem(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useExtraPlayerControlsAlwaysVisible() {
  return useSyncExternalStore(subscribe, readExtraControlsAlwaysVisible, () => true);
}
