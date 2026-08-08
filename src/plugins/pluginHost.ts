import { useSyncExternalStore } from "react";
import { getAppSetting, setAppSetting } from "../internal/appSettings";

export type PluginKind = "official" | "imported";
export type PluginPermission =
  | "tracks:read"
  | "playlists:read"
  | "downloads:write"
  | "filesystem:write"
  | "playback:source-resolver";

export type PluginSettingField =
  | {
      key: string;
      type: "folder" | "text" | "toggle";
      label: string;
      required?: boolean;
      default?: string | boolean;
    }
  | {
      key: string;
      type: "select";
      label: string;
      options: Array<{ value: string; label: string }>;
      default?: string;
    }
  | {
      key: string;
      type: "action";
      label: string;
      action: string;
    };

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  entry: string;
  requiresRestart: boolean;
  permissions: PluginPermission[];
  settings: PluginSettingField[];
}

interface PluginRecord {
  manifest: PluginManifest;
  enabled: boolean;
}

const PLUGIN_STATE_KEY = "plugins.enabled.v1";
const listeners = new Set<() => void>();
const plugins = new Map<string, PluginRecord>();
let snapshotCache: PluginRecord[] = [];

function emit(): void {
  snapshotCache = [...plugins.values()].map((record) => ({
    manifest: record.manifest,
    enabled: record.enabled,
  }));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PluginRecord[] {
  return snapshotCache;
}

function readEnabledMap(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLUGIN_STATE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, boolean>
      : {};
  } catch {
    return {};
  }
}

function writeEnabledMap(enabled: Record<string, boolean>): void {
  localStorage.setItem(PLUGIN_STATE_KEY, JSON.stringify(enabled));
  void setAppSetting(PLUGIN_STATE_KEY, enabled);
}

export async function hydratePluginHost(): Promise<void> {
  const durable = await getAppSetting<Record<string, boolean>>(PLUGIN_STATE_KEY);
  if (durable && typeof durable === "object") {
    localStorage.setItem(PLUGIN_STATE_KEY, JSON.stringify(durable));
    for (const [pluginId, enabled] of Object.entries(durable)) {
      const record = plugins.get(pluginId);
      if (record) record.enabled = enabled;
    }
  }
  emit();
}

export function registerOfficialPlugin(manifest: PluginManifest, enabledByDefault = true): void {
  const enabledMap = readEnabledMap();
  plugins.set(manifest.id, {
    manifest,
    enabled: enabledMap[manifest.id] ?? enabledByDefault,
  });
  emit();
}

export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const record = plugins.get(pluginId);
  if (!record) return;
  record.enabled = enabled;
  writeEnabledMap({ ...readEnabledMap(), [pluginId]: enabled });
  emit();
  window.dispatchEvent(new CustomEvent("plugin-enabled-change", {
    detail: { pluginId, enabled },
  }));
}

export function isPluginEnabled(pluginId: string): boolean {
  return plugins.get(pluginId)?.enabled ?? false;
}

export function getPlugin(pluginId: string): PluginRecord | undefined {
  const record = plugins.get(pluginId);
  return record
    ? { manifest: record.manifest, enabled: record.enabled }
    : undefined;
}

export function getPlugins(): PluginRecord[] {
  return snapshot();
}

export function usePlugins(): PluginRecord[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function usePluginEnabled(pluginId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isPluginEnabled(pluginId),
    () => isPluginEnabled(pluginId),
  );
}
