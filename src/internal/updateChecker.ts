import { getVersion } from "@tauri-apps/api/app";

const RELEASES_API_URL =
  "https://api.github.com/repos/2latemc/JustAnotherMusicClient/releases?per_page=30";
const LATEST_RELEASE_URL =
  "https://github.com/2latemc/JustAnotherMusicClient/releases/latest";
const NOTIFY_MARKER = "[notify-update]";
const SNOOZE_PREFIX = "just-another-music-client:update-snooze:";
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

interface GitHubRelease {
  tag_name: string;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

interface ParsedVersion {
  core: number[];
  prerelease: Array<number | string>;
}

export interface UpdateInfo {
  installedVersion: string;
  version: string;
  releaseUrl: string;
  prerelease: boolean;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] > b.core[index] ? 1 : -1;
    }
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    if (typeof aPart === "number" && typeof bPart === "string") return -1;
    if (typeof aPart === "string" && typeof bPart === "number") return 1;
    return aPart > bPart ? 1 : -1;
  }

  return 0;
}

function cleanVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

export async function getInstalledVersion(): Promise<string> {
  return getVersion();
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  const installedVersion = await getInstalledVersion();
  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub release check failed with status ${response.status}.`);
  }

  const releases = (await response.json()) as GitHubRelease[];
  const notifiedReleases = releases
    .filter(
      (release) =>
        !release.draft
        && release.body?.toLowerCase().includes(NOTIFY_MARKER) === true
        && parseVersion(release.tag_name) !== null,
    )
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  const latest = notifiedReleases[0];
  if (!latest || compareVersions(latest.tag_name, installedVersion) <= 0) {
    return null;
  }

  return {
    installedVersion,
    version: cleanVersion(latest.tag_name),
    releaseUrl: latest.prerelease ? latest.html_url : LATEST_RELEASE_URL,
    prerelease: latest.prerelease,
  };
}

export function isUpdateSnoozed(version: string): boolean {
  const snoozedUntil = Number(localStorage.getItem(`${SNOOZE_PREFIX}${version}`));
  return Number.isFinite(snoozedUntil) && snoozedUntil > Date.now();
}

export function snoozeUpdate(version: string): void {
  localStorage.setItem(
    `${SNOOZE_PREFIX}${version}`,
    String(Date.now() + SNOOZE_DURATION_MS),
  );
}
