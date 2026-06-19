export const isMacOS =
  typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

export const isLinux =
  typeof navigator !== "undefined" && /Linux/.test(navigator.userAgent);

export const isWindows =
  typeof navigator !== "undefined" && /Windows NT/.test(navigator.userAgent);

export const primaryModifierLabel = isMacOS ? "⌘" : "Ctrl";

export function applyPlatformAttributes() {
  document.documentElement.toggleAttribute("data-platform-linux", isLinux);
}

export function hasPrimaryModifierOnly(event: KeyboardEvent): boolean {
  return isMacOS
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}
