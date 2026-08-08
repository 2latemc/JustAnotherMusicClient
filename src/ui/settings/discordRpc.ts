import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";
import { DiscordRpcService } from "../../player/DiscordRPC";

const STORAGE_KEY = "discord-rpc-enabled";
const CHANGE_EVENT = "discord-rpc-settings-change";

function readDiscordRpcEnabled() {
  return readLocalBooleanSetting(STORAGE_KEY, true);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setDiscordRpcEnabled(enabled: boolean) {
  writeLocalBooleanSetting(STORAGE_KEY, enabled, CHANGE_EVENT);
  void DiscordRpcService.setEnabled(enabled);
}

export async function hydrateDiscordRpcSettings() {
  await hydrateLocalBooleanSetting(STORAGE_KEY, true, CHANGE_EVENT, (enabled) =>
    DiscordRpcService.setEnabled(enabled),
  );
}

export function useDiscordRpcEnabled() {
  return useSyncExternalStore(subscribe, readDiscordRpcEnabled, () => true);
}
