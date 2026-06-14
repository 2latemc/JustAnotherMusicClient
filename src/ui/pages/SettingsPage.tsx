import { useEffect, useState } from "react";
import {
  IconBug,
  IconDatabase,
  IconLogin,
  IconLogout,
  IconLeaf,
  IconRocket,
  IconRefresh,
  IconStar,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  checkForUpdates,
  getInstalledVersion,
  type UpdateInfo,
} from "../../internal/updateChecker";
import {
  clearCache,
  DEFAULT_CACHE_SIZE_GB,
  getCacheStats,
  setCacheMaxBytes,
  type CacheStats,
} from "../../internal/cache";
import type { LibraryController, LibraryState } from "../../player/LibraryController";
import {
  getAutostartEnabled,
  setAutostartEnabled,
} from "../settings/autostart";
import { setPaperPcMode, usePaperPcMode } from "../settings/paperPcMode";
import styles from "./SettingsPage.module.css";

const GITHUB_REPOSITORY_URL = "https://github.com/2latemc/JustAnotherMusicClient";
const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPOSITORY_URL}/issues/new/choose`;

interface SettingsPageProps {
  libraryController: LibraryController;
  libraryState: LibraryState;
  onRestartOnboarding: () => void;
  onSignIn: () => Promise<void>;
}

export function SettingsPage({
  libraryController,
  libraryState,
  onRestartOnboarding,
  onSignIn,
}: SettingsPageProps) {
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheSizeGb, setCacheSizeGb] = useState(DEFAULT_CACHE_SIZE_GB.toString());
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "current" | "error"
  >("idle");
  const [autostartEnabled, setAutostartEnabledState] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const paperPcMode = usePaperPcMode();
  const account = libraryState.library?.account;
  const isSignedIn = libraryState.status === "ready" && account;
  const authBusy = libraryState.status === "restoring"
    || libraryState.status === "authorizing"
    || libraryState.status === "loading";

  useEffect(() => {
    let active = true;
    void getCacheStats()
      .then((stats) => {
        if (!active) return;
        setCacheStats(stats);
        setCacheSizeGb((stats.maxBytes / 1024 ** 3).toString());
      })
      .catch(() => {
        if (active) setCacheError("Unable to load cache settings.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getInstalledVersion()
      .then((version) => {
        if (active) setInstalledVersion(version);
      })
      .catch(() => {
        if (active) setInstalledVersion("Unknown");
      });
    return () => {
      active = false;
    };
  }, []);

  const handleCheckForUpdates = async () => {
    setUpdateStatus("checking");
    setUpdateResult(null);
    try {
      const update = await checkForUpdates();
      setUpdateResult(update);
      setUpdateStatus(update ? "idle" : "current");
    } catch {
      setUpdateStatus("error");
    }
  };

  useEffect(() => {
    let active = true;
    void getAutostartEnabled()
      .then((enabled) => {
        if (active) setAutostartEnabledState(enabled);
      })
      .catch(() => {
        if (active) setAutostartError("Unable to load the startup setting.");
      })
      .finally(() => {
        if (active) setAutostartLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleAutostartChange = async (enabled: boolean) => {
    setAutostartLoading(true);
    setAutostartError(null);
    try {
      await setAutostartEnabled(enabled);
      setAutostartEnabledState(enabled);
    } catch {
      setAutostartError("Unable to update the startup setting.");
    } finally {
      setAutostartLoading(false);
    }
  };

  const saveCacheSize = async () => {
    const sizeGb = Number(cacheSizeGb);
    if (!Number.isFinite(sizeGb) || sizeGb < 0.25 || sizeGb > 64) {
      setCacheError("Cache size must be between 0.25 GB and 64 GB.");
      return;
    }

    setCacheBusy(true);
    setCacheError(null);
    try {
      setCacheStats(await setCacheMaxBytes(Math.round(sizeGb * 1024 ** 3)));
    } catch {
      setCacheError("Unable to save the cache size.");
    } finally {
      setCacheBusy(false);
    }
  };

  const handleClearCache = async () => {
    setCacheBusy(true);
    setCacheError(null);
    try {
      setCacheStats(await clearCache());
    } catch {
      setCacheError("Unable to clear cached content.");
    } finally {
      setCacheBusy(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Application</span>
        <h1>Settings</h1>
        <p>Manage the YouTube Music account connected to this client.</p>
      </div>

      <div className={styles.githubActions}>
        <button
          className={styles.githubButton}
          type="button"
          onClick={() => void openUrl(GITHUB_REPOSITORY_URL)}
        >
          <IconStar size={18} />
          Star us on GitHub
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => void openUrl(GITHUB_NEW_ISSUE_URL)}
        >
          <IconBug size={18} />
          Report an issue or request a feature
        </button>
      </div>

      <section className={styles.card} aria-labelledby="account-settings-title">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="account-settings-title">Account</h2>
            <p>{isSignedIn ? "Signed in to YouTube Music" : "No account connected"}</p>
          </div>
          <span className={`${styles.status} ${isSignedIn ? styles.connected : ""}`}>
            {isSignedIn ? "Connected" : "Signed out"}
          </span>
        </div>

        <div className={styles.accountRow}>
          {account?.artworkUrl ? (
            <img className={styles.avatar} src={account.artworkUrl} alt="" />
          ) : (
            <div className={styles.avatarPlaceholder}>
              <IconUser size={30} />
            </div>
          )}

          <div className={styles.accountDetails}>
            <span className={styles.accountName}>{account?.name ?? "YouTube Music"}</span>
            <span className={styles.accountDescription}>
              {isSignedIn ? "Your library and listening history are available." : "Sign in to load your library."}
            </span>
          </div>

          {isSignedIn ? (
            <button
              className={styles.signOutButton}
              type="button"
              onClick={() => void libraryController.signOut()}
            >
              <IconLogout size={18} />
              Sign out
            </button>
          ) : (
            <button
              className={styles.signInButton}
              type="button"
              disabled={authBusy}
              onClick={() => void onSignIn()}
            >
              <IconLogin size={18} />
              {authBusy ? "Connecting..." : "Sign in"}
            </button>
          )}
        </div>

        {libraryState.error && <p className={styles.error}>{libraryState.error}</p>}
      </section>

      <section className={styles.card} aria-labelledby="cache-settings-title">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="cache-settings-title">Cache</h2>
            <p>Keep library, album, and track data available between sessions.</p>
          </div>
          <IconDatabase className={styles.cardIcon} size={22} />
        </div>

        <div className={styles.cacheBody}>
          <div className={styles.cacheUsage}>
            <span>Used space</span>
            <strong>
              {cacheStats
                ? `${formatBytes(cacheStats.usedBytes)} of ${formatBytes(cacheStats.maxBytes)}`
                : "Loading..."}
            </strong>
            <span>{cacheStats?.entryCount ?? 0} cached items</span>
          </div>

          <div className={styles.cacheControls}>
            <label className={styles.cacheSizeField}>
              <span>Maximum size</span>
              <span className={styles.inputWithUnit}>
                <input
                  type="number"
                  min="0.25"
                  max="64"
                  step="0.25"
                  value={cacheSizeGb}
                  disabled={cacheBusy}
                  onChange={(event) => setCacheSizeGb(event.target.value)}
                />
                <span>GB</span>
              </span>
            </label>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={cacheBusy}
              onClick={() => void saveCacheSize()}
            >
              Save
            </button>
            <button
              className={styles.dangerButton}
              type="button"
              disabled={cacheBusy}
              onClick={() => void handleClearCache()}
            >
              <IconTrash size={18} />
              Clear cache
            </button>
          </div>
        </div>

        {cacheError && <p className={styles.error}>{cacheError}</p>}
      </section>

      <section className={styles.card} aria-labelledby="startup-settings-title">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="startup-settings-title">Startup</h2>
            <p>Control whether the app opens automatically when you sign in.</p>
          </div>
          <IconRocket className={styles.cardIcon} size={22} />
        </div>

        <label className={`${styles.toggleRow} ${autostartLoading ? styles.toggleRowDisabled : ""}`}>
          <span className={styles.toggleDescription}>
            <strong>Launch at startup</strong>
            <span>Start Just Another Music Client when your computer starts.</span>
          </span>
          <input
            className={styles.toggleInput}
            type="checkbox"
            checked={autostartEnabled}
            disabled={autostartLoading}
            onChange={(event) => void handleAutostartChange(event.target.checked)}
          />
          <span className={styles.toggle} aria-hidden="true" />
        </label>

        {autostartError && <p className={styles.error}>{autostartError}</p>}
      </section>

      <section className={styles.card} aria-labelledby="performance-settings-title">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="performance-settings-title">Performance</h2>
            <p>Reduce GPU-heavy visual effects on older or low-power computers.</p>
          </div>
          <IconLeaf className={styles.cardIcon} size={22} />
        </div>

        <label className={styles.toggleRow}>
          <span className={styles.toggleDescription}>
            <strong>Potato PC mode</strong>
            <span>Disables animations, blur effects, and the animated star background.</span>
          </span>
          <input
            className={styles.toggleInput}
            type="checkbox"
            checked={paperPcMode}
            onChange={(event) => setPaperPcMode(event.target.checked)}
          />
          <span className={styles.toggle} aria-hidden="true" />
        </label>
      </section>

      <section className={styles.card} aria-labelledby="update-settings-title">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="update-settings-title">Updates</h2>
            <p>
              Installed version: {
                installedVersion
                  ? installedVersion === "Unknown" ? installedVersion : `v${installedVersion}`
                  : "Loading..."
              }
            </p>
          </div>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={updateStatus === "checking"}
            onClick={() => void handleCheckForUpdates()}
          >
            <IconRefresh size={18} />
            {updateStatus === "checking" ? "Checking..." : "Check for updates"}
          </button>
        </div>
        {updateResult && (
          <div className={styles.updateResult}>
            <span>Version {updateResult.version} is available.</span>
            <button
              className={styles.githubButton}
              type="button"
              onClick={() => void openUrl(updateResult.releaseUrl)}
            >
              Download
            </button>
          </div>
        )}
        {updateStatus === "current" && (
          <p className={styles.updateMessage}>You are up to date.</p>
        )}
        {updateStatus === "error" && (
          <p className={styles.error}>Unable to check for updates.</p>
        )}
      </section>

      <section className={styles.card} aria-labelledby="onboarding-settings-title">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="onboarding-settings-title">Quick start</h2>
            <p>Replay the guided introduction to search, playback, and music tabs.</p>
          </div>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={onRestartOnboarding}
          >
            <IconRefresh size={18} />
            Start onboarding
          </button>
        </div>
      </section>

    </main>
  );
}
