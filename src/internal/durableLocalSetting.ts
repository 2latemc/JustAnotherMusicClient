import { getAppSetting, setAppSetting } from "./appSettings";

export function readLocalBooleanSetting(key: string, defaultValue: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === "true";
  } catch {
    return defaultValue;
  }
}

export function writeLocalBooleanSetting(
  key: string,
  enabled: boolean,
  changeEvent: string,
): void {
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    // Durable app settings still get the write below.
  }

  window.dispatchEvent(new Event(changeEvent));
  void setAppSetting(key, enabled);
}

export async function hydrateLocalBooleanSetting(
  key: string,
  defaultValue: boolean,
  changeEvent: string,
  apply?: (enabled: boolean) => void | Promise<void>,
): Promise<void> {
  const stored = await getAppSetting<boolean>(key);
  const nextValue = typeof stored === "boolean"
    ? stored
    : readLocalBooleanSetting(key, defaultValue);

  try {
    localStorage.setItem(key, String(nextValue));
  } catch {
    // The in-memory UI still receives the event below.
  }

  await apply?.(nextValue);
  window.dispatchEvent(new Event(changeEvent));

  if (typeof stored !== "boolean") {
    void setAppSetting(key, nextValue);
  }
}

export function readLocalJsonSetting<T>(
  key: string,
  isValid: (value: unknown) => value is T,
): T | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLocalJsonSetting<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Durable app settings still get the write below.
  }

  void setAppSetting(key, value);
}

export async function hydrateLocalJsonSetting<T>(
  key: string,
  isValid: (value: unknown) => value is T,
): Promise<void> {
  const stored = await getAppSetting<unknown>(key);
  if (isValid(stored)) {
    try {
      localStorage.setItem(key, JSON.stringify(stored));
    } catch {
      // A later explicit save will retry durable persistence.
    }
    return;
  }

  const localValue = readLocalJsonSetting(key, isValid);
  if (localValue) {
    void setAppSetting(key, localValue);
  }
}
