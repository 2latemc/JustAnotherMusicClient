import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { AudioQuality } from "../../../internal/audioQuality";
import { getAppSetting, setAppSetting } from "../../../internal/appSettings";
import { logInternalError, logInternalInfo, logInternalWarn } from "../../../internal/logging";
import type { StreamData } from "../../../datasource/DataSource";
import type { Playlist, Track } from "../../../datasource/types";
import { appErrorManager } from "../../../ui/errors/errorManager";
import { isPluginEnabled } from "../../pluginHost";
import { DOWNLOADER_PLUGIN_ID } from "./manifest";

const MANIFEST_KEY = "plugin.downloader.manifest.v1";
const SETTINGS_KEY = "plugin.downloader.settings.v1";
const CHANGE_EVENT = "downloader-store-change";

type DownloadStatus = "absent" | "queued" | "downloading" | "paused" | "ready" | "failed";

interface DownloaderSettings {
  downloadPath: string | null;
  quality: AudioQuality;
}

export interface DownloadEntry {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  mimeType: string;
  filePath: string;
  byteLength: number;
  downloadedAt: number;
  artworkUrl?: string;
}

export interface DownloaderState {
  entries: Record<string, DownloadEntry>;
  queued: string[];
  pending: Record<string, Track>;
  downloadingId: string | null;
  progress: number | null;
  paused: boolean;
  failed: Record<string, string>;
  settings: DownloaderSettings;
  hydrating: boolean;
}

type StreamResolver = (track: Track, quality: AudioQuality) => Promise<{
  url: string;
  mimeType: string;
  cookie?: string;
}>;

type DownloadAudioSaveResult = {
  filePath: string;
  byteLength: number;
};

type DownloadAudioSourceResult = {
  url: string;
  mimeType: string;
  byteLength: number;
};

type DownloadAudioDiscoveredFile = {
  trackId: string;
  filePath: string;
  mimeType: string;
  byteLength: number;
  modifiedAtMs: number;
};

type DownloadProgressPayload = {
  trackId: string;
  percent: number;
};

const listeners = new Set<() => void>();
const DEFAULT_SETTINGS: DownloaderSettings = {
  downloadPath: null,
  quality: "normal",
};

let state: DownloaderState = {
  entries: {},
  queued: [],
  pending: {},
  downloadingId: null,
  progress: null,
  paused: false,
  failed: {},
  settings: DEFAULT_SETTINGS,
  hydrating: true,
};
let resolver: StreamResolver | null = null;
let pumping = false;
let progressStarted = false;

function emit(): void {
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function setState(next: Partial<DownloaderState>): void {
  state = { ...state, ...next };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDownloaderState(): DownloaderState {
  return state;
}

export function useDownloaderState(): DownloaderState {
  return useSyncExternalStore(subscribe, getDownloaderState, getDownloaderState);
}

function parseRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function readManifest(): Record<string, DownloadEntry> {
  try {
    return parseRecord<DownloadEntry>(JSON.parse(localStorage.getItem(MANIFEST_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function writeManifest(entries: Record<string, DownloadEntry>): void {
  try {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(entries));
  } catch (error) {
    logInternalWarn("downloader.writeManifest localStorage failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void setAppSetting(MANIFEST_KEY, entries);
}

function readSettings(): DownloaderSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    const value = parsed as Partial<DownloaderSettings>;
    return {
      downloadPath: typeof value.downloadPath === "string" && value.downloadPath.trim()
        ? value.downloadPath
        : null,
      quality: value.quality === "low" || value.quality === "high" ? value.quality : "normal",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: DownloaderSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  void setAppSetting(SETTINGS_KEY, settings);
}

async function ensureDownloadPath(): Promise<string> {
  if (state.settings.downloadPath) return state.settings.downloadPath;
  const path = await invoke<string>("download_default_folder");
  const settings = { ...state.settings, downloadPath: path };
  writeSettings(settings);
  setState({ settings });
  return path;
}

function commitEntries(entries: Record<string, DownloadEntry>): void {
  writeManifest(entries);
  setState({ entries });
}

function reportDownloadFailure(track: Track, message: string): void {
  appErrorManager.report(`${track.title}: ${message}`, {
    title: "Download failed",
  });
}

function getDownloadErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    error
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
  ) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isCancellationMessage(message: string): boolean {
  const normalized = message.toLocaleLowerCase();
  return normalized.includes("cancelled") || normalized.includes("canceled");
}

export async function hydrateDownloaderStore(): Promise<void> {
  let settings = readSettings();
  const durableSettings = await getAppSetting<DownloaderSettings>(SETTINGS_KEY);
  if (durableSettings && typeof durableSettings === "object") {
    settings = {
      downloadPath: typeof durableSettings.downloadPath === "string"
        ? durableSettings.downloadPath
        : settings.downloadPath,
      quality: durableSettings.quality === "low" || durableSettings.quality === "high"
        ? durableSettings.quality
        : durableSettings.quality === "normal"
          ? "normal"
          : settings.quality,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  const durableManifest = await getAppSetting<Record<string, DownloadEntry>>(MANIFEST_KEY);
  const manifest = { ...parseRecord<DownloadEntry>(durableManifest), ...readManifest() };

  setState({ settings, hydrating: false });
  await reconcileDownloads(manifest);
  startProgressFeed();
}

export function setDownloaderStreamResolver(nextResolver: StreamResolver): void {
  resolver = nextResolver;
}

export function getDownloadStatus(trackId: string): DownloadStatus {
  if (state.entries[trackId]) return "ready";
  if (state.downloadingId === trackId) return "downloading";
  if (state.queued.includes(trackId)) return state.paused ? "paused" : "queued";
  if (state.failed[trackId]) return "failed";
  return "absent";
}

export function queueDownload(track: Track): void {
  if (!isPluginEnabled(DOWNLOADER_PLUGIN_ID) || track.source === "local") return;
  if (state.entries[track.id] || state.downloadingId === track.id || state.queued.includes(track.id)) return;
  const { [track.id]: _failed, ...failed } = state.failed;
  setState({
    queued: [...state.queued, track.id],
    pending: { ...state.pending, [track.id]: track },
    failed,
    paused: false,
  });
  void pump();
}

export function queueDownloads(tracks: Track[]): void {
  for (const track of tracks) queueDownload(track);
}

export function pauseDownloads(): void {
  const activeId = state.downloadingId;
  setState({ paused: true });
  if (activeId) {
    void invoke("download_audio_cancel", { trackId: activeId }).catch(() => {});
  }
}

export function resumeDownloads(): void {
  if (!state.paused) return;
  setState({ paused: false });
  void pump();
}

export function togglePlaylistDownloads(tracks: Track[]): void {
  if (state.downloadingId || state.queued.length > 0) {
    if (state.paused) resumeDownloads();
    else pauseDownloads();
    return;
  }
  queueDownloads(tracks);
}

export async function setDownloadPath(downloadPath: string): Promise<void> {
  const settings = { ...state.settings, downloadPath };
  writeSettings(settings);
  setState({ settings });
}

export async function setDownloadQuality(quality: AudioQuality): Promise<void> {
  const settings = { ...state.settings, quality };
  writeSettings(settings);
  setState({ settings });
}

export async function rediscoverDownloads(): Promise<void> {
  const folder = await ensureDownloadPath();
  const files = await invoke<DownloadAudioDiscoveredFile[]>("download_audio_list", { folder });
  const nextEntries = { ...state.entries };
  for (const file of files) {
    const existing = nextEntries[file.trackId];
    nextEntries[file.trackId] = {
      trackId: file.trackId,
      title: existing?.title ?? file.trackId,
      artist: existing?.artist ?? "Unknown artist",
      album: existing?.album,
      mimeType: file.mimeType,
      filePath: file.filePath,
      byteLength: file.byteLength,
      downloadedAt: existing?.downloadedAt ?? file.modifiedAtMs,
      artworkUrl: existing?.artworkUrl,
    };
  }
  commitEntries(nextEntries);
}

export function getDownloadedTracks(): Track[] {
  return Object.values(state.entries)
    .sort((left, right) => right.downloadedAt - left.downloadedAt)
    .map((entry) => ({
      id: entry.trackId,
      source: "youtube",
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      artworkUrl: entry.artworkUrl,
    }));
}

export async function getDownloaderPlaybackSource(track: Track): Promise<StreamData | null> {
  if (!isPluginEnabled(DOWNLOADER_PLUGIN_ID) || track.source !== "youtube") return null;
  const entry = state.entries[track.id];
  if (!entry) return null;
  try {
    const payload = await invoke<DownloadAudioSourceResult>("download_audio_source", {
      filePath: entry.filePath,
      mimeType: entry.mimeType,
      trackId: track.id,
    });
    if (payload.byteLength === 0) return null;
    return { sourceUrl: payload.url, mimeType: payload.mimeType };
  } catch {
    const { [track.id]: _missing, ...entries } = state.entries;
    commitEntries(entries);
    return null;
  }
}

function startProgressFeed(): void {
  if (progressStarted) return;
  progressStarted = true;
  void listen<DownloadProgressPayload>("download-progress", (event) => {
    if (event.payload.trackId !== state.downloadingId) return;
    setState({ progress: event.payload.percent });
  });
}

async function reconcileDownloads(manifest: Record<string, DownloadEntry>): Promise<void> {
  const entries: Record<string, DownloadEntry> = {};
  for (const [trackId, entry] of Object.entries(manifest)) {
    try {
      const exists = await invoke<boolean>("download_audio_file_exists", { filePath: entry.filePath });
      if (exists) entries[trackId] = entry;
    } catch {
      entries[trackId] = entry;
    }
  }
  commitEntries(entries);
}

async function pump(): Promise<void> {
  if (pumping || state.paused || state.downloadingId || state.queued.length === 0) return;
  if (!resolver) {
    logInternalWarn("downloader.pump missing stream resolver");
    return;
  }

  pumping = true;
  try {
    while (!state.paused && state.queued.length > 0) {
      const [trackId, ...rest] = state.queued;
      const track = state.pending[trackId];
      setState({ queued: rest, downloadingId: trackId, progress: null });
      if (!track) {
        setState({ downloadingId: null, progress: null });
        continue;
      }

      try {
        const folder = await ensureDownloadPath();
        const stream = await resolver(track, state.settings.quality);
        logInternalInfo("downloader.download start", { trackId, title: track.title });
        const saved = await invoke<DownloadAudioSaveResult>("download_audio_save", {
          url: stream.url,
          trackId,
          title: track.title,
          artist: track.artist,
          folder,
          mimeType: stream.mimeType,
          cookie: stream.cookie,
        });
        const { [trackId]: _pending, ...pending } = state.pending;
        commitEntries({
          ...state.entries,
          [trackId]: {
            trackId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            mimeType: stream.mimeType,
            filePath: saved.filePath,
            byteLength: saved.byteLength,
            downloadedAt: Date.now(),
            artworkUrl: track.artworkUrl,
          },
        });
        setState({ pending, downloadingId: null, progress: null });
      } catch (error) {
        const message = getDownloadErrorMessage(error);
        logInternalError("downloader.download failed", error, { trackId });
        if (state.paused && isCancellationMessage(message)) {
          setState({
            queued: [trackId, ...state.queued.filter((id) => id !== trackId)],
            downloadingId: null,
            progress: null,
          });
          continue;
        }

        const { [trackId]: _pending, ...pending } = state.pending;
        reportDownloadFailure(track, message);
        setState({
          pending,
          downloadingId: null,
          progress: null,
          failed: { ...state.failed, [trackId]: message },
        });
      }
    }
  } finally {
    pumping = false;
  }
}

export function getPlaylistDownloadSummary(_playlist: Playlist, tracks: Track[]): {
  total: number;
  downloaded: number;
  active: boolean;
  paused: boolean;
} {
  const ids = new Set(tracks.filter((track) => track.source !== "local").map((track) => track.id));
  return {
    total: ids.size,
    downloaded: [...ids].filter((id) => Boolean(state.entries[id])).length,
    active: Boolean(state.downloadingId && ids.has(state.downloadingId))
      || state.queued.some((id) => ids.has(id)),
    paused: state.paused,
  };
}
