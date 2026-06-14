import { invoke } from "@tauri-apps/api/core";
import { logInternalDebug, logInternalWarn } from "../internal/logging";

export interface DiscordPresenceData {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  duration: number; // in seconds
  currentTime: number; // in seconds
  isPlaying: boolean;
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
      logInternalDebug("Discord.updatePresence", {
        title: data.title,
        artist: data.artist,
        isPlaying: data.isPlaying,
      });

      // Call Tauri command to update presence in Rust backend
      await invoke("discord_rpc_update", {
        title: data.title,
        artist: data.artist,
        album: data.album,
        artworkUrl: data.artworkUrl,
        duration: Math.floor(data.duration),
        currentTime: Math.floor(data.currentTime),
        isPlaying: data.isPlaying,
      });

      logInternalDebug("Discord.updatePresence.success", {});
    } catch (error) {
      logInternalWarn("Discord.updatePresence.failed", error);
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
      logInternalWarn("Discord.clearPresence.failed", error);
    }
  }
}

export default DiscordRpcService;
