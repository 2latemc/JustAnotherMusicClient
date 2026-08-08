import type { PluginManifest } from "../../pluginHost";
import { registerOfficialPlugin } from "../../pluginHost";

export const DOWNLOADER_PLUGIN_ID = "downloader";

export const downloaderPluginManifest: PluginManifest = {
  schemaVersion: 1,
  id: DOWNLOADER_PLUGIN_ID,
  name: "Downloader",
  version: "1.0.0",
  kind: "official",
  entry: "index.js",
  requiresRestart: false,
  permissions: [
    "tracks:read",
    "playlists:read",
    "downloads:write",
    "filesystem:write",
    "playback:source-resolver",
  ],
  settings: [
    {
      key: "downloadPath",
      type: "folder",
      label: "Download folder",
      required: true,
    },
    {
      key: "quality",
      type: "select",
      label: "Quality",
      default: "normal",
      options: [
        { value: "high", label: "High" },
        { value: "normal", label: "Normal" },
        { value: "low", label: "Low" },
      ],
    },
    {
      key: "rediscoverDownloads",
      type: "action",
      label: "Rediscover downloads",
      action: "rediscoverDownloads",
    },
  ],
};

export function registerDownloaderPlugin(): void {
  // Imported plugins will use the same host later. The official downloader is default-on.
  registerOfficialPlugin(downloaderPluginManifest, true);
}
