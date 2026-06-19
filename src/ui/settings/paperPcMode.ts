import { useSyncExternalStore } from "react";
import { isLinux } from "../platform";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

const STORAGE_KEY = "paper-pc-mode";
const CHANGE_EVENT = "paper-pc-mode-change";

function readPaperPcMode() {
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

export function applyPaperPcMode(enabled = readPaperPcMode()) {
  document.documentElement.toggleAttribute("data-paper-pc", enabled);
}

export async function hydratePaperPcMode() {
  await hydrateLocalBooleanSetting(STORAGE_KEY, false, CHANGE_EVENT, applyPaperPcMode);
}

export function setPaperPcMode(enabled: boolean) {
  writeLocalBooleanSetting(STORAGE_KEY, enabled, CHANGE_EVENT);

  if (isLinux) {
    window.location.reload();
    return;
  }

  applyPaperPcMode(enabled);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function usePaperPcMode() {
  return useSyncExternalStore(subscribe, readPaperPcMode, () => false);
}
