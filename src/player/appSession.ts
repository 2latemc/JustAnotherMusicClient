import type { Tab } from "../ui/types/tab";
import type { TabManagerSession } from "./TabManager";

const STORAGE_KEY = "yt-music-dock.app-session.v1";

export interface AppSession {
  version: 1;
  tabs: Tab[];
  activeTabId: string;
  nextTabId: number;
  player: TabManagerSession;
}

export function loadAppSession(): AppSession | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as AppSession | null;
    if (
      parsed?.version !== 1
      || !Array.isArray(parsed.tabs)
      || parsed.tabs.length === 0
      || typeof parsed.activeTabId !== "string"
      || typeof parsed.nextTabId !== "number"
      || !parsed.player
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveAppSession(session: AppSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Persistence failure should not interrupt playback.
  }
}

export function clearAppSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Persistence failure should not interrupt a full reset.
  }
}
