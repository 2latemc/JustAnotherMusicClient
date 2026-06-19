import { invoke } from "@tauri-apps/api/core";
import { logInternalWarn } from "./logging";

export async function getAppSetting<T>(key: string): Promise<T | null> {
  try {
    return await invoke<T | null>("app_setting_get", { key });
  } catch (error) {
    logInternalWarn("appSetting.get failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function setAppSetting<T>(key: string, value: T): Promise<void> {
  try {
    await invoke("app_setting_set", { key, value });
  } catch (error) {
    logInternalWarn("appSetting.set failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function removeAppSetting(key: string): Promise<void> {
  try {
    await invoke("app_setting_remove", { key });
  } catch (error) {
    logInternalWarn("appSetting.remove failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
