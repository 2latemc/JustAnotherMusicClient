import { useSyncExternalStore } from "react";
import { getAppSetting, setAppSetting } from "../../internal/appSettings";
import { isMacOS } from "../platform";

export type KeyboardShortcutAction =
  | "playPause"
  | "mute"
  | "previousTrack"
  | "nextTrack"
  | "closeTab"
  | "newTab"
  | "search"
  | "tab1"
  | "tab2"
  | "tab3"
  | "tab4"
  | "tab5"
  | "tab6"
  | "tab7"
  | "tab8"
  | "tab9";

export interface KeyboardShortcut {
  code: string;
  key: string;
  primary?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export type KeyboardShortcutMap = Record<KeyboardShortcutAction, KeyboardShortcut | null>;

export const KEYBOARD_SHORTCUTS_STORAGE_KEY = "keyboard-shortcuts";
const CHANGE_EVENT = "keyboard-shortcuts-change";
let cachedKeyboardShortcuts: KeyboardShortcutMap | null = null;

export const KEYBOARD_SHORTCUT_ACTIONS: Array<{
  id: KeyboardShortcutAction;
  label: string;
  description: string;
}> = [
  {
    id: "playPause",
    label: "Play / pause",
    description: "Toggle playback for the current track.",
  },
  {
    id: "mute",
    label: "Mute / unmute",
    description: "Toggle player audio.",
  },
  {
    id: "previousTrack",
    label: "Previous track",
    description: "Go back to the previous track.",
  },
  {
    id: "nextTrack",
    label: "Next track",
    description: "Skip to the next track.",
  },
  {
    id: "closeTab",
    label: "Close tab",
    description: "Close the active tab.",
  },
  {
    id: "newTab",
    label: "New tab",
    description: "Open a new music tab.",
  },
  {
    id: "search",
    label: "Search",
    description: "Open or close search.",
  },
  {
    id: "tab1",
    label: "Go to tab 1",
    description: "Switch to the first tab.",
  },
  {
    id: "tab2",
    label: "Go to tab 2",
    description: "Switch to the second tab.",
  },
  {
    id: "tab3",
    label: "Go to tab 3",
    description: "Switch to the third tab.",
  },
  {
    id: "tab4",
    label: "Go to tab 4",
    description: "Switch to the fourth tab.",
  },
  {
    id: "tab5",
    label: "Go to tab 5",
    description: "Switch to the fifth tab.",
  },
  {
    id: "tab6",
    label: "Go to tab 6",
    description: "Switch to the sixth tab.",
  },
  {
    id: "tab7",
    label: "Go to tab 7",
    description: "Switch to the seventh tab.",
  },
  {
    id: "tab8",
    label: "Go to tab 8",
    description: "Switch to the eighth tab.",
  },
  {
    id: "tab9",
    label: "Go to tab 9",
    description: "Switch to the ninth tab.",
  },
];

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  playPause: { code: "Space", key: " " },
  mute: { code: "KeyM", key: "m" },
  previousTrack: { code: "ArrowLeft", key: "ArrowLeft", primary: true },
  nextTrack: { code: "ArrowRight", key: "ArrowRight", primary: true },
  closeTab: { code: "KeyW", key: "w", primary: true },
  newTab: { code: "KeyT", key: "t", primary: true },
  search: { code: "Space", key: " ", primary: true },
  tab1: { code: "Digit1", key: "1", primary: true },
  tab2: { code: "Digit2", key: "2", primary: true },
  tab3: { code: "Digit3", key: "3", primary: true },
  tab4: { code: "Digit4", key: "4", primary: true },
  tab5: { code: "Digit5", key: "5", primary: true },
  tab6: { code: "Digit6", key: "6", primary: true },
  tab7: { code: "Digit7", key: "7", primary: true },
  tab8: { code: "Digit8", key: "8", primary: true },
  tab9: { code: "Digit9", key: "9", primary: true },
};

const modifierCodes = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

function isKeyboardShortcut(value: unknown): value is KeyboardShortcut {
  if (typeof value !== "object" || value === null) return false;
  const shortcut = value as KeyboardShortcut;
  return (
    typeof shortcut.code === "string"
    && typeof shortcut.key === "string"
    && (shortcut.primary === undefined || typeof shortcut.primary === "boolean")
    && (shortcut.ctrl === undefined || typeof shortcut.ctrl === "boolean")
    && (shortcut.meta === undefined || typeof shortcut.meta === "boolean")
    && (shortcut.alt === undefined || typeof shortcut.alt === "boolean")
    && (shortcut.shift === undefined || typeof shortcut.shift === "boolean")
  );
}

function isShortcutMap(value: unknown): value is Partial<KeyboardShortcutMap> {
  if (typeof value !== "object" || value === null) return false;
  return KEYBOARD_SHORTCUT_ACTIONS.every(({ id }) => {
    const shortcut = (value as Partial<KeyboardShortcutMap>)[id];
    return shortcut === undefined || shortcut === null || isKeyboardShortcut(shortcut);
  });
}

function normalizeShortcut(shortcut: KeyboardShortcut): KeyboardShortcut {
  const next: KeyboardShortcut = {
    code: shortcut.code,
    key: shortcut.key,
  };
  if (shortcut.primary) next.primary = true;
  if (shortcut.ctrl) next.ctrl = true;
  if (shortcut.meta) next.meta = true;
  if (shortcut.alt) next.alt = true;
  if (shortcut.shift) next.shift = true;
  return next;
}

function normalizeShortcutMap(value: Partial<KeyboardShortcutMap>): KeyboardShortcutMap {
  const next = { ...DEFAULT_KEYBOARD_SHORTCUTS };
  for (const { id } of KEYBOARD_SHORTCUT_ACTIONS) {
    if (!(id in value)) continue;
    const shortcut = value[id];
    next[id] = shortcut ? normalizeShortcut(shortcut) : null;
  }
  return next;
}

function readKeyboardShortcuts(): KeyboardShortcutMap {
  if (cachedKeyboardShortcuts) return cachedKeyboardShortcuts;

  try {
    const parsed = JSON.parse(
      localStorage.getItem(KEYBOARD_SHORTCUTS_STORAGE_KEY) ?? "null",
    ) as unknown;
    cachedKeyboardShortcuts = isShortcutMap(parsed)
      ? normalizeShortcutMap(parsed)
      : DEFAULT_KEYBOARD_SHORTCUTS;
    return cachedKeyboardShortcuts;
  } catch {
    cachedKeyboardShortcuts = DEFAULT_KEYBOARD_SHORTCUTS;
    return DEFAULT_KEYBOARD_SHORTCUTS;
  }
}

function writeKeyboardShortcuts(shortcuts: KeyboardShortcutMap): void {
  cachedKeyboardShortcuts = shortcuts;
  try {
    localStorage.setItem(KEYBOARD_SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {
    // Durable app settings still get the write below.
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
  void setAppSetting(KEYBOARD_SHORTCUTS_STORAGE_KEY, shortcuts);
}

function subscribe(callback: () => void) {
  const handleChange = () => {
    callback();
  };
  const handleStorage = () => {
    cachedKeyboardShortcuts = null;
    callback();
  };

  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function getKeyboardShortcuts() {
  return readKeyboardShortcuts();
}

export async function hydrateKeyboardShortcuts() {
  const stored = await getAppSetting<unknown>(KEYBOARD_SHORTCUTS_STORAGE_KEY);
  const shortcuts = isShortcutMap(stored)
    ? normalizeShortcutMap(stored)
    : readKeyboardShortcuts();
  cachedKeyboardShortcuts = shortcuts;

  try {
    localStorage.setItem(KEYBOARD_SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {
    // The in-memory UI still receives the event below.
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
  if (!isShortcutMap(stored)) {
    void setAppSetting(KEYBOARD_SHORTCUTS_STORAGE_KEY, shortcuts);
  }
}

export function setKeyboardShortcut(
  action: KeyboardShortcutAction,
  shortcut: KeyboardShortcut | null,
) {
  const shortcuts = { ...readKeyboardShortcuts() };
  const normalizedShortcut = shortcut ? normalizeShortcut(shortcut) : null;

  if (normalizedShortcut) {
    for (const { id } of KEYBOARD_SHORTCUT_ACTIONS) {
      if (id !== action && areShortcutsEqual(shortcuts[id], normalizedShortcut)) {
        shortcuts[id] = null;
      }
    }
  }

  shortcuts[action] = normalizedShortcut;
  writeKeyboardShortcuts(shortcuts);
}

export function resetKeyboardShortcut(action: KeyboardShortcutAction) {
  setKeyboardShortcut(action, DEFAULT_KEYBOARD_SHORTCUTS[action]);
}

export function resetKeyboardShortcuts() {
  writeKeyboardShortcuts(normalizeShortcutMap(DEFAULT_KEYBOARD_SHORTCUTS));
}

export function useKeyboardShortcuts() {
  return useSyncExternalStore(
    subscribe,
    readKeyboardShortcuts,
    () => DEFAULT_KEYBOARD_SHORTCUTS,
  );
}

export function captureKeyboardShortcut(event: KeyboardEvent): KeyboardShortcut | null {
  if (modifierCodes.has(event.code)) return null;

  const primaryPressed = isMacOS ? event.metaKey : event.ctrlKey;
  const shortcut: KeyboardShortcut = {
    code: event.code,
    key: event.key,
  };

  if (primaryPressed) shortcut.primary = true;
  if (event.altKey) shortcut.alt = true;
  if (event.shiftKey) shortcut.shift = true;
  if (isMacOS && event.ctrlKey) shortcut.ctrl = true;
  if (!isMacOS && event.metaKey) shortcut.meta = true;

  return normalizeShortcut(shortcut);
}

export function eventMatchesShortcut(
  event: KeyboardEvent,
  shortcut: KeyboardShortcut | null,
): boolean {
  if (!shortcut) return false;

  const primaryPressed = isMacOS ? event.metaKey : event.ctrlKey;
  const explicitCtrlPressed = isMacOS ? event.ctrlKey : false;
  const explicitMetaPressed = isMacOS ? false : event.metaKey;

  return (
    event.code === shortcut.code
    && primaryPressed === Boolean(shortcut.primary)
    && explicitCtrlPressed === Boolean(shortcut.ctrl)
    && explicitMetaPressed === Boolean(shortcut.meta)
    && event.altKey === Boolean(shortcut.alt)
    && event.shiftKey === Boolean(shortcut.shift)
  );
}

export function areShortcutsEqual(
  first: KeyboardShortcut | null,
  second: KeyboardShortcut | null,
): boolean {
  if (!first || !second) return first === second;
  return (
    first.code === second.code
    && Boolean(first.primary) === Boolean(second.primary)
    && Boolean(first.ctrl) === Boolean(second.ctrl)
    && Boolean(first.meta) === Boolean(second.meta)
    && Boolean(first.alt) === Boolean(second.alt)
    && Boolean(first.shift) === Boolean(second.shift)
  );
}

function getKeyLabel(shortcut: KeyboardShortcut): string {
  if (shortcut.code === "Space") return "Space";
  if (shortcut.code === "ArrowLeft") return "Left";
  if (shortcut.code === "ArrowRight") return "Right";
  if (shortcut.code === "ArrowUp") return "Up";
  if (shortcut.code === "ArrowDown") return "Down";
  if (shortcut.code === "Escape") return "Esc";
  if (shortcut.code === "Backspace") return "Backspace";
  if (shortcut.code === "Delete") return "Delete";
  if (shortcut.code === "Enter") return "Enter";
  if (/^Key[A-Z]$/.test(shortcut.code)) return shortcut.code.slice(3);
  if (/^Digit[0-9]$/.test(shortcut.code)) return shortcut.code.slice(5);
  return shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
}

export function formatKeyboardShortcut(shortcut: KeyboardShortcut | null): string {
  if (!shortcut) return "None";

  const parts: string[] = [];
  if (shortcut.primary) parts.push(isMacOS ? "Cmd" : "Ctrl");
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.meta) parts.push("Meta");
  if (shortcut.alt) parts.push(isMacOS ? "Option" : "Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(getKeyLabel(shortcut));
  return parts.join(" + ");
}
