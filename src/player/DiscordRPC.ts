import { invoke } from "@tauri-apps/api/core";
import { logInternalDebug, logInternalWarn } from "../internal/logging";

export interface DiscordPresenceData {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  songUrl?: string;
  artistUrl?: string;
  albumUrl?: string;
  duration: number; // in seconds
  currentTime: number; // in seconds
  isPlaying: boolean;
}

const DISCORD_TEXT_LIMIT = 128;
const DISCORD_ASSET_URL_LIMIT = 256;
const TRUSTED_ARTWORK_HOSTS = new Set([
  "i.ytimg.com",
  "lh3.googleusercontent.com",
  "yt3.ggpht.com",
]);
const TRUSTED_PRESENCE_LINK_HOSTS = new Set([
  "music.youtube.com",
  "youtube.com",
  "www.youtube.com",
]);

function sanitizeDiscordText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= DISCORD_TEXT_LIMIT) return text;
  return `${text.slice(0, DISCORD_TEXT_LIMIT - 3)}...`;
}

function sanitizeArtworkUrl(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return undefined;
    if (!TRUSTED_ARTWORK_HOSTS.has(parsed.hostname)) return undefined;
    const url = parsed.toString();
    if (url.length > DISCORD_ASSET_URL_LIMIT) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function sanitizePresenceLink(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return undefined;
    if (!TRUSTED_PRESENCE_LINK_HOSTS.has(parsed.hostname)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function sanitizePresenceData(data: DiscordPresenceData): DiscordPresenceData {
  return {
    title: sanitizeDiscordText(data.title),
    artist: sanitizeDiscordText(data.artist),
    album: sanitizeDiscordText(data.album),
    artworkUrl: sanitizeArtworkUrl(data.artworkUrl),
    songUrl: sanitizePresenceLink(data.songUrl),
    artistUrl: sanitizePresenceLink(data.artistUrl),
    albumUrl: sanitizePresenceLink(data.albumUrl),
    duration: Math.max(0, Math.floor(Number.isFinite(data.duration) ? data.duration : 0)),
    currentTime: Math.max(0, Math.floor(Number.isFinite(data.currentTime) ? data.currentTime : 0)),
    isPlaying: data.isPlaying,
  };
}

/**
 * Manages Discord Rich Presence integration
 * Calls Tauri commands that handle the actual Discord connection in Rust
 */
export class DiscordRpcService {
  private static isEnabled = true;

  /**
   * Initialize Discord RPC
   * The actual connection happens on the Rust backend
   */
  static async init(): Promise<void> {
    logInternalDebug("Discord.init", { message: "Rust backend will handle connection" });
  }

  /**
   * Update Discord presence with current track information
   * @param data The current track and playback information
   */
  static async updatePresence(data: DiscordPresenceData): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      const safeData = sanitizePresenceData(data);
      logInternalDebug("Discord.updatePresence", {
        title: safeData.title,
        artist: safeData.artist,
        isPlaying: safeData.isPlaying,
      });

      // Call Tauri command to update presence in Rust backend
      await invoke("discord_rpc_update", {
        title: safeData.title,
        artist: safeData.artist,
        album: safeData.album,
        artworkUrl: safeData.artworkUrl,
        songUrl: safeData.songUrl,
        artistUrl: safeData.artistUrl,
        albumUrl: safeData.albumUrl,
        duration: safeData.duration,
        currentTime: safeData.currentTime,
        isPlaying: safeData.isPlaying,
      });

      logInternalDebug("Discord.updatePresence.success", {});
    } catch (error) {
      logInternalWarn("Discord.updatePresence.failed", error as Record<string, unknown>);
    }
  }
  /**
   * Clear Discord presence (show as idle)
   */
  static async clearPresence(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      logInternalDebug("Discord.clearPresence", {});
      await invoke("discord_rpc_clear");
      logInternalDebug("Discord.clearPresence.success", {});
    } catch (error) {
      logInternalWarn("Discord.clearPresence.failed", error as Record<string, unknown>);
    }
  }
}

export default DiscordRpcService;
