import { getVersion } from "@tauri-apps/api/app";

const RELEASES_API_URL =
  "https://api.github.com/repos/2latemc/JustAnotherMusicClient/releases/tags";
const RELEASE_TAG_PREFIX = "v";
const CHANGELOG_SHOWN_PREFIX = "just-another-music-client:changelog-shown:";
const CHANGELOG_START_MARKER = /<!--\s*app-changelog:start\s*-->/i;
const CHANGELOG_END_MARKER = /<!--\s*app-changelog:end\s*-->/i;

export interface ReleaseChangelog {
  version: string;
  changes: string;
  releaseUrl: string;
}

export function extractAppChangelog(releaseBody: string): string | null {
  const startMatch = CHANGELOG_START_MARKER.exec(releaseBody);
  if (!startMatch || startMatch.index === undefined) return null;

  const contentStart = startMatch.index + startMatch[0].length;
  const remainingBody = releaseBody.slice(contentStart);
  const endMatch = CHANGELOG_END_MARKER.exec(remainingBody);
  if (!endMatch || endMatch.index === undefined) return null;

  const changes = remainingBody.slice(0, endMatch.index).trim();
  return changes.length > 0 ? changes : null;
}

export async function fetchInstalledReleaseChangelog(): Promise<ReleaseChangelog | null> {
  const installedVersion = await getVersion();
  const releaseTag = `${RELEASE_TAG_PREFIX}${installedVersion.replace(/^v/, "")}`;
  const releaseUrl =
    `https://github.com/2latemc/JustAnotherMusicClient/releases/tag/${encodeURIComponent(releaseTag)}`;
  const response = await fetch(`${RELEASES_API_URL}/${encodeURIComponent(releaseTag)}`);
  if (!response.ok) return null;

  const data = await response.json() as { body?: unknown };
  if (typeof data.body !== "string") return null;

  const changes = extractAppChangelog(data.body);
  if (!changes) return null;

  return {
    version: installedVersion,
    changes,
    releaseUrl,
  };
}

export function hasShownReleaseChangelog(version: string): boolean {
  try {
    return localStorage.getItem(`${CHANGELOG_SHOWN_PREFIX}${version}`) === "true";
  } catch {
    return true;
  }
}

export function markReleaseChangelogShown(version: string): void {
  try {
    localStorage.setItem(`${CHANGELOG_SHOWN_PREFIX}${version}`, "true");
  } catch {
    // localStorage can be unavailable in restricted webviews. The popup remains dismissible.
  }
}
