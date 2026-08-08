import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

const AUTHENTICATED_STREAMING_KEY = "youtube-authenticated-streaming";
const SCROBBLING_KEY = "youtube-scrobbling";
const CHANGE_EVENT = "youtube-account-settings-change";

let cachedAuthenticatedStreaming: boolean | null = null;
let cachedScrobbling: boolean | null = null;

function readAuthenticatedStreaming(): boolean {
  if (cachedAuthenticatedStreaming === null) {
    cachedAuthenticatedStreaming = readLocalBooleanSetting(AUTHENTICATED_STREAMING_KEY, true);
  }
  return cachedAuthenticatedStreaming;
}

function readScrobbling(): boolean {
  if (cachedScrobbling === null) {
    cachedScrobbling = readLocalBooleanSetting(SCROBBLING_KEY, true);
  }
  return cachedScrobbling;
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", () => {
    cachedAuthenticatedStreaming = null;
    cachedScrobbling = null;
  });
}

export function usesAuthenticatedStreaming(): boolean {
  return readAuthenticatedStreaming();
}

export function usesYouTubeScrobbling(): boolean {
  return readScrobbling();
}

export function setAuthenticatedStreaming(enabled: boolean): void {
  cachedAuthenticatedStreaming = enabled;
  writeLocalBooleanSetting(AUTHENTICATED_STREAMING_KEY, enabled, CHANGE_EVENT);
}

export function setYouTubeScrobbling(enabled: boolean): void {
  cachedScrobbling = enabled;
  writeLocalBooleanSetting(SCROBBLING_KEY, enabled, CHANGE_EVENT);
}

export async function hydrateYouTubeAccountSettings(): Promise<void> {
  await Promise.all([
    hydrateLocalBooleanSetting(AUTHENTICATED_STREAMING_KEY, true, CHANGE_EVENT),
    hydrateLocalBooleanSetting(SCROBBLING_KEY, true, CHANGE_EVENT),
  ]);
  cachedAuthenticatedStreaming = null;
  cachedScrobbling = null;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useAuthenticatedStreaming(): boolean {
  return useSyncExternalStore(subscribe, readAuthenticatedStreaming, () => true);
}

export function useYouTubeScrobbling(): boolean {
  return useSyncExternalStore(subscribe, readScrobbling, () => true);
}
