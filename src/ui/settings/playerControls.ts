import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

const EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY = "extra-player-controls-always-visible";
const CHANGE_EVENT = "player-controls-change";

function readExtraControlsAlwaysVisible() {
  return readLocalBooleanSetting(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY, true);
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
  writeLocalBooleanSetting(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY, enabled, CHANGE_EVENT);
}

export async function hydratePlayerControlSettings() {
  await hydrateLocalBooleanSetting(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY, true, CHANGE_EVENT);
}

export function useExtraPlayerControlsAlwaysVisible() {
  return useSyncExternalStore(subscribe, readExtraControlsAlwaysVisible, () => true);
}
