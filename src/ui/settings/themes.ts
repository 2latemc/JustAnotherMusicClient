import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import matrixThemeCss from "../themes/matrix.css?raw";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { logInternalWarn } from "../../internal/logging";

export type AppTheme = "dark" | "light" | "matrix" | "custom";
export interface MatrixThemeSettings {
  rainSpeed: number;
  mediaAging: number;
}

export const APP_THEMES: Array<{ id: AppTheme; label: string }> = [
  {
    id: "dark",
    label: "Dark",
  },
  {
    id: "light",
    label: "Light",
  },
  {
    id: "matrix",
    label: "Matrix",
  },
  {
    id: "custom",
    label: "Custom CSS",
  },
];

const STORAGE_KEY = "app-theme";
const CHANGE_EVENT = "app-theme-change";
const MATRIX_SETTINGS_STORAGE_KEY = "matrix-theme-settings";
const MATRIX_SETTINGS_CHANGE_EVENT = "matrix-theme-settings-change";
const CUSTOM_STYLE_ID = "app-custom-theme-css";
const DEFAULT_MATRIX_THEME_SETTINGS: MatrixThemeSettings = {
  rainSpeed: 100,
  mediaAging: 100,
};
let matrixThemeSettingsSnapshot = DEFAULT_MATRIX_THEME_SETTINGS;

function isAppTheme(value: unknown): value is AppTheme {
  return value === "dark" || value === "light" || value === "matrix" || value === "custom";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function isMatrixThemeSettings(value: unknown): value is MatrixThemeSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<MatrixThemeSettings>;
  return typeof settings.rainSpeed === "number"
    && Number.isFinite(settings.rainSpeed)
    && typeof settings.mediaAging === "number"
    && Number.isFinite(settings.mediaAging);
}

function readAppTheme(): AppTheme {
  const stored = readLocalJsonSetting(STORAGE_KEY, (value): value is AppTheme | "default" =>
    isAppTheme(value) || value === "default"
  );
  return stored === "default" ? "dark" : stored ?? "dark";
}

function normalizeMatrixThemeSettings(settings: Partial<MatrixThemeSettings>): MatrixThemeSettings {
  return {
    rainSpeed: clampNumber(
      settings.rainSpeed,
      DEFAULT_MATRIX_THEME_SETTINGS.rainSpeed,
      25,
      300,
    ),
    mediaAging: clampNumber(
      settings.mediaAging,
      DEFAULT_MATRIX_THEME_SETTINGS.mediaAging,
      0,
      200,
    ),
  };
}

function readMatrixThemeSettings(): MatrixThemeSettings {
  const stored = readLocalJsonSetting(MATRIX_SETTINGS_STORAGE_KEY, isMatrixThemeSettings);
  return normalizeMatrixThemeSettings(stored ?? DEFAULT_MATRIX_THEME_SETTINGS);
}

function getMatrixThemeSettingsSnapshot() {
  const nextSettings = readMatrixThemeSettings();
  if (
    matrixThemeSettingsSnapshot.rainSpeed === nextSettings.rainSpeed
    && matrixThemeSettingsSnapshot.mediaAging === nextSettings.mediaAging
  ) {
    return matrixThemeSettingsSnapshot;
  }

  matrixThemeSettingsSnapshot = nextSettings;
  return matrixThemeSettingsSnapshot;
}

function getCustomStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(CUSTOM_STYLE_ID);
  if (existing instanceof HTMLStyleElement) return existing;

  const style = document.createElement("style");
  style.id = CUSTOM_STYLE_ID;
  style.setAttribute("data-app-custom-theme", "true");
  document.head.append(style);
  return style;
}

function setCustomThemeCss(css: string) {
  const style = getCustomStyleElement();
  style.textContent = css;
  document.head.append(style);
}

function applyThemeAttribute(theme: AppTheme) {
  document.documentElement.dataset.appTheme = theme;
}

function applyMatrixThemeSettings(settings = readMatrixThemeSettings()) {
  const rainDurationScale = 100 / settings.rainSpeed;
  document.documentElement.style.setProperty(
    "--matrix-rain-duration-scale",
    rainDurationScale.toFixed(3),
  );
  document.documentElement.style.setProperty(
    "--matrix-media-aging",
    (settings.mediaAging / 100).toFixed(2),
  );
}

export function subscribeToAppTheme(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function subscribeToMatrixThemeSettings(callback: () => void) {
  window.addEventListener(MATRIX_SETTINGS_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(MATRIX_SETTINGS_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getAppTheme() {
  return readAppTheme();
}

export function useAppTheme() {
  return useSyncExternalStore(subscribeToAppTheme, readAppTheme, () => "dark");
}

export function useMatrixThemeSettings() {
  return useSyncExternalStore(
    subscribeToMatrixThemeSettings,
    getMatrixThemeSettingsSnapshot,
    () => DEFAULT_MATRIX_THEME_SETTINGS,
  );
}

export function dispatchAppThemeChange() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function applyAppTheme(theme = readAppTheme()) {
  applyThemeAttribute(theme);
  applyMatrixThemeSettings();

  if (theme === "matrix") {
    setCustomThemeCss(matrixThemeCss);
    return;
  }

  if (theme !== "custom") {
    setCustomThemeCss("");
    return;
  }

  void invoke<string | null>("custom_theme_css_get")
    .then((css) => setCustomThemeCss(css ?? ""))
    .catch((error) => {
      logInternalWarn("custom theme load failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      setCustomThemeCss("");
    });
}

export async function hydrateAppTheme() {
  await hydrateLocalJsonSetting(STORAGE_KEY, isAppTheme);
  await hydrateLocalJsonSetting(MATRIX_SETTINGS_STORAGE_KEY, isMatrixThemeSettings);
  applyAppTheme();
  dispatchAppThemeChange();
  window.dispatchEvent(new Event(MATRIX_SETTINGS_CHANGE_EVENT));
}

export function setAppTheme(theme: AppTheme) {
  writeLocalJsonSetting(STORAGE_KEY, theme);
  applyAppTheme(theme);
  dispatchAppThemeChange();
}

export function setMatrixThemeSettings(settings: Partial<MatrixThemeSettings>) {
  const nextSettings = normalizeMatrixThemeSettings({
    ...readMatrixThemeSettings(),
    ...settings,
  });
  matrixThemeSettingsSnapshot = nextSettings;
  writeLocalJsonSetting(MATRIX_SETTINGS_STORAGE_KEY, nextSettings);
  applyMatrixThemeSettings(nextSettings);
  window.dispatchEvent(new Event(MATRIX_SETTINGS_CHANGE_EVENT));
}

export async function importCustomThemeCss(path: string) {
  await invoke("custom_theme_css_import", { path });
  setAppTheme("custom");
}
