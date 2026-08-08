import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

const STORAGE_KEY = "minimize-to-system-tray-enabled";
const CHANGE_EVENT = "minimize-to-system-tray-enabled-change";

function readMinimizeToTrayEnabled() {
  return readLocalBooleanSetting(STORAGE_KEY, false);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setMinimizeToTrayEnabled(enabled: boolean) {
  writeLocalBooleanSetting(STORAGE_KEY, enabled, CHANGE_EVENT);
}

export async function hydrateMinimizeToTraySettings() {
  await hydrateLocalBooleanSetting(STORAGE_KEY, false, CHANGE_EVENT);
}

export function useMinimizeToTrayEnabled() {
  return useSyncExternalStore(subscribe, readMinimizeToTrayEnabled, () => false);
}
