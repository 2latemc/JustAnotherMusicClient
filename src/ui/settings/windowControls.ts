import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logInternalError } from "../../internal/logging";

const WINDOWS_STYLE_STORAGE_KEY = "windows-style-window-controls";
const NATIVE_CONTROLS_STORAGE_KEY = "native-window-controls";
const CHANGE_EVENT = "window-controls-change";

function readBooleanSetting(key: string) {
  return localStorage.getItem(key) === "true";
}

function writeBooleanSetting(key: string, enabled: boolean) {
  localStorage.setItem(key, String(enabled));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function readWindowsStyleWindowControls() {
  return readBooleanSetting(WINDOWS_STYLE_STORAGE_KEY);
}

function readNativeWindowControls() {
  return readBooleanSetting(NATIVE_CONTROLS_STORAGE_KEY);
}

export function setWindowsStyleWindowControls(enabled: boolean) {
  writeBooleanSetting(WINDOWS_STYLE_STORAGE_KEY, enabled);
}

export function setNativeWindowControls(enabled: boolean) {
  writeBooleanSetting(NATIVE_CONTROLS_STORAGE_KEY, enabled);
  void applyNativeWindowControls(enabled);
}

export async function applyNativeWindowControls(enabled = readNativeWindowControls()) {
  try {
    await getCurrentWindow().setDecorations(enabled);
    document.documentElement.toggleAttribute("data-native-window-controls", enabled);
  } catch (error) {
    logInternalError("windowControls.applyNativeWindowControls failed", error);
  }
}

export function useWindowsStyleWindowControls() {
  return useSyncExternalStore(subscribe, readWindowsStyleWindowControls, () => false);
}

export function useNativeWindowControls() {
  return useSyncExternalStore(subscribe, readNativeWindowControls, () => false);
}
