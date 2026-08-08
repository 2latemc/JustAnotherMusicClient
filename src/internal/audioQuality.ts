import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "./durableLocalSetting";

export type AudioQuality = "low" | "normal" | "high";

const STREAMING_KEY = "audio-quality-streaming";
const CHANGE_EVENT = "audio-quality-change";

const QUALITY_TARGET_KBPS: Record<Exclude<AudioQuality, "high">, number> = {
  low: 64,
  normal: 128,
};

export const AUDIO_QUALITY_LABELS: Record<AudioQuality, string> = {
  low: "Low (~64 kbps)",
  normal: "Normal (~128 kbps)",
  high: "High (best available)",
};

function isAudioQuality(value: unknown): value is AudioQuality {
  return value === "low" || value === "normal" || value === "high";
}

function read(): AudioQuality {
  return readLocalJsonSetting<AudioQuality>(STREAMING_KEY, isAudioQuality) ?? "normal";
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getStreamingQuality(): AudioQuality {
  return read();
}

export function setStreamingQuality(quality: AudioQuality): void {
  writeLocalJsonSetting(STREAMING_KEY, quality);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export async function hydrateAudioQualitySettings(): Promise<void> {
  await hydrateLocalJsonSetting<AudioQuality>(STREAMING_KEY, isAudioQuality);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useStreamingQuality(): AudioQuality {
  return useSyncExternalStore(subscribe, getStreamingQuality, () => "normal");
}

export function selectFormatForQuality<T extends { bitrate?: number | null }>(
  formats: T[],
  quality: AudioQuality,
): T | undefined {
  if (formats.length === 0) return undefined;

  const ranked = [...formats].sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0));
  if (quality === "high") return ranked[0];

  const targetBps = QUALITY_TARGET_KBPS[quality] * 1000;
  return ranked.reduce((best, format) => {
    const distance = Math.abs((format.bitrate ?? 0) - targetBps);
    const bestDistance = Math.abs((best.bitrate ?? 0) - targetBps);
    return distance < bestDistance ? format : best;
  }, ranked[0]);
}
