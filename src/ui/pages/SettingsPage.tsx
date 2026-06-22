import { type CSSProperties, useEffect, useState } from "react";
import {
  IconBug,
  IconCoffee,
  IconFileDescription,
  IconLayoutSidebarRight,
  IconLogin,
  IconLogout,
  IconRefresh,
  IconStar,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  checkForUpdates,
  getUpdateFailureMessage,
  getInstalledVersion,
  installUpdate,
  type UpdateInfo,
  type UpdateInstallProgress,
} from "../../internal/updateChecker";
import { clearAppSettings, removeAppSetting } from "../../internal/appSettings";
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
import {
  setExtraPlayerControlsAlwaysVisible,
  useExtraPlayerControlsAlwaysVisible,
} from "../settings/playerControls";
import { setPaperPcMode, usePaperPcMode } from "../settings/paperPcMode";
import {
  setNativeWindowControls,
  setWindowsStyleWindowControls,
  useNativeWindowControls,
  useWindowsStyleWindowControls,
} from "../settings/windowControls";
import {
  resetMiniPlayerPosition,
  setMiniPlayerEnabled,
  useMiniPlayerEnabled,
} from "../settings/miniPlayer";
import styles from "./SettingsPage.module.css";

const GITHUB_REPOSITORY_URL = "https://github.com/2latemc/JustAnotherMusicClient";
const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPOSITORY_URL}/issues/new/choose`;
const KOFI_URL = "https://ko-fi.com/totally2late";

type SettingsTab = "about" | "system" | "window";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "about", label: "About" },
  { id: "system", label: "System" },
  { id: "window", label: "Style" },
];

const APP_SETTING_KEYS = [
  "onboardingComplete",
  "mini-player-enabled",
  "mini-player-position",
  "paper-pc-mode",
  "extra-player-controls-always-visible",
  "windows-style-window-controls",
  "native-window-controls",
];

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
    "idle" | "checking" | "installing" | "current" | "error"
  >("idle");
  const [updateProgress, setUpdateProgress] = useState<UpdateInstallProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [autostartEnabled, setAutostartEnabledState] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [logOpening, setLogOpening] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [miniPlayerResetting, setMiniPlayerResetting] = useState(false);
  const [resetSettingsConfirming, setResetSettingsConfirming] = useState(false);
  const [resetSettingsBusy, setResetSettingsBusy] = useState(false);
  const [resetSettingsError, setResetSettingsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("about");
  const paperPcMode = usePaperPcMode();
  const miniPlayerEnabled = useMiniPlayerEnabled();
  const extraPlayerControlsAlwaysVisible = useExtraPlayerControlsAlwaysVisible();
  const windowsStyleWindowControls = useWindowsStyleWindowControls();
  const nativeWindowControls = useNativeWindowControls();
  const account = libraryState.library?.account;
  const isSignedIn = libraryState.status === "ready" && account;
  const activeTabIndex = Math.max(0, SETTINGS_TABS.findIndex((tab) => tab.id === activeTab));
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

  useEffect(() => {
    if (!resetSettingsConfirming) return undefined;
    const timeout = window.setTimeout(() => setResetSettingsConfirming(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [resetSettingsConfirming]);

  const handleCheckForUpdates = async () => {
    setUpdateStatus("checking");
    setUpdateResult(null);
    setUpdateError(null);
    setUpdateProgress(null);
    try {
      const update = await checkForUpdates();
      setUpdateResult(update);
      setUpdateStatus(update ? "idle" : "current");
    } catch (error) {
      setUpdateError(getUpdateFailureMessage(error));
      setUpdateStatus("error");
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateResult) return;
    setUpdateStatus("installing");
    setUpdateError(null);
    try {
      await installUpdate(updateResult, setUpdateProgress);
    } catch {
      setUpdateError("Unable to install the update. You can download it from GitHub.");
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

  const handleOpenLog = async () => {
    setLogOpening(true);
    setLogError(null);
    try {
      await invoke("open_current_log");
    } catch {
      setLogError("Unable to open the log file.");
    } finally {
      setLogOpening(false);
    }
  };

  const handleResetMiniPlayerPosition = async () => {
    setMiniPlayerResetting(true);
    try {
      await resetMiniPlayerPosition();
    } finally {
      setMiniPlayerResetting(false);
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

  const handleClearAllSettings = async () => {
    setResetSettingsError(null);
    if (!resetSettingsConfirming) {
      setResetSettingsConfirming(true);
      return;
    }

    setResetSettingsBusy(true);
    try {
      await setAutostartEnabled(false).catch(() => undefined);
      await clearAppSettings().catch(async () => {
        await Promise.all(APP_SETTING_KEYS.map((key) => removeAppSetting(key)));
      });
      try {
        localStorage.clear();
      } catch {
        APP_SETTING_KEYS.forEach((key) => {
          try {
            localStorage.removeItem(key);
          } catch {
            // Reload still applies any durable settings that were cleared.
          }
        });
      }
      await relaunch().catch(() => {
        window.location.reload();
      });
    } catch {
      setResetSettingsError("Unable to delete settings.");
      setResetSettingsBusy(false);
      setResetSettingsConfirming(false);
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
        <p>Manage account, system, and window behavior.</p>
      </div>

      <div className={styles.githubActions}>
        <button
          className={styles.githubButton}
          type="button"
          onClick={() => void openUrl(KOFI_URL)}
        >
          <IconCoffee size={18} />
          Buy me a coffee
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => void openUrl(GITHUB_REPOSITORY_URL)}
        >
          <IconStar size={18} />
          Star on GitHub
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

      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Settings categories"
        style={{
          "--active-tab-offset": `${activeTabIndex * 100}%`,
          "--tab-count": SETTINGS_TABS.length,
        } as CSSProperties}
      >
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? styles.activeTab : ""}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "about" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="About settings">
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

          <section className={styles.card} aria-labelledby="about-settings-title">
            <div className={styles.compactHeader}>
              <h2 id="about-settings-title">About</h2>
            </div>

            <div className={styles.settingsList}>
              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Updates</strong>
                  <span>
                    Installed version: {
                      installedVersion
                        ? installedVersion === "Unknown" ? installedVersion : `v${installedVersion}`
                        : "Loading..."
                    }
                  </span>
                </span>
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
                  <span>
                    {updateStatus === "installing"
                      ? updateProgress?.percent !== undefined
                        ? `Downloading version ${updateResult.version}: ${updateProgress.percent}%`
                        : `Preparing version ${updateResult.version}...`
                      : `Version ${updateResult.version} is available.`}
                  </span>
                  {updateResult.canInstall && (
                    <button
                      className={styles.githubButton}
                      type="button"
                      disabled={updateStatus === "installing"}
                      onClick={() => void handleInstallUpdate()}
                    >
                      {updateStatus === "installing" ? "Installing..." : "Install"}
                    </button>
                  )}
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    onClick={() => void openUrl(updateResult.releaseUrl)}
                  >
                    {updateResult.canInstall ? "View changes" : "Download"}
                  </button>
                </div>
              )}
              {updateStatus === "current" && (
                <p className={styles.updateMessage}>You are up to date.</p>
              )}
              {updateStatus === "error" && (
                <p className={styles.error}>{updateError}</p>
              )}

              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Quick start</strong>
                  <span>Replay the guided introduction.</span>
                </span>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={onRestartOnboarding}
                >
                  <IconRefresh size={18} />
                  Start onboarding
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {activeTab === "system" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="System settings">
          <section className={styles.card} aria-labelledby="system-settings-title">
            <div className={styles.compactHeader}>
              <h2 id="system-settings-title">System</h2>
            </div>

            <div className={styles.settingsList}>
              <label className={`${styles.settingRow} ${autostartLoading ? styles.toggleRowDisabled : ""}`}>
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

              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Application log</strong>
                  <span>Open the current log file for sharing or troubleshooting.</span>
                </span>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={logOpening}
                  onClick={() => void handleOpenLog()}
                >
                  <IconFileDescription size={18} />
                  {logOpening ? "Opening..." : "Open log"}
                </button>
              </div>

              {logError && <p className={styles.error}>{logError}</p>}

              <label className={styles.settingRow}>
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

              <div className={styles.cacheRow}>
                <div className={styles.cacheUsage}>
                  <span>Cache</span>
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

              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Delete all settings</strong>
                  <span>Reset app preferences, layout, onboarding, and local settings.</span>
                </span>
                <button
                  className={styles.dangerButton}
                  type="button"
                  disabled={resetSettingsBusy}
                  onClick={() => void handleClearAllSettings()}
                >
                  <IconTrash size={18} />
                  {resetSettingsBusy
                    ? "Deleting..."
                    : resetSettingsConfirming
                      ? "Press again to confirm"
                      : "Delete settings"}
                </button>
              </div>

              {resetSettingsError && <p className={styles.error}>{resetSettingsError}</p>}
            </div>
          </section>
        </div>
      )}

      {activeTab === "window" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="Style settings">
          <section className={styles.card} aria-labelledby="window-settings-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="window-settings-title">Window controls</h2>
                <p>Choose the title bar buttons and compact player behavior.</p>
              </div>
              <IconLayoutSidebarRight className={styles.cardIcon} size={22} />
            </div>

            <label className={styles.toggleRow}>
              <span className={styles.toggleDescription}>
                <strong>Mini player</strong>
                <span>Show compact playback controls when the main window is not focused.</span>
              </span>
              <input
                className={styles.toggleInput}
                type="checkbox"
                checked={miniPlayerEnabled}
                onChange={(event) => setMiniPlayerEnabled(event.target.checked)}
              />
              <span className={styles.toggle} aria-hidden="true" />
            </label>

            <div className={styles.settingActionRow}>
              <span className={styles.toggleDescription}>
                <strong>Mini player position</strong>
                <span>Move the mini player back to the bottom center of this screen.</span>
              </span>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={miniPlayerResetting}
                onClick={() => void handleResetMiniPlayerPosition()}
              >
                {miniPlayerResetting ? "Resetting..." : "Reset position"}
              </button>
            </div>

            <label className={styles.toggleRow}>
              <span className={styles.toggleDescription}>
                <strong>Windows-style controls</strong>
                <span>Use minimize, maximize, and close buttons with square edges.</span>
              </span>
              <input
                className={styles.toggleInput}
                type="checkbox"
                checked={windowsStyleWindowControls}
                disabled={nativeWindowControls}
                onChange={(event) => setWindowsStyleWindowControls(event.target.checked)}
              />
              <span className={styles.toggle} aria-hidden="true" />
            </label>

            <label className={styles.toggleRow}>
              <span className={styles.toggleDescription}>
                <strong>Use OS native controls</strong>
                <span>Let the operating system draw the window frame and title bar.</span>
              </span>
              <input
                className={styles.toggleInput}
                type="checkbox"
                checked={nativeWindowControls}
                onChange={(event) => setNativeWindowControls(event.target.checked)}
              />
              <span className={styles.toggle} aria-hidden="true" />
            </label>
          </section>

          <section className={styles.card} aria-labelledby="behavior-settings-title">
            <div className={styles.compactHeader}>
              <h2 id="behavior-settings-title">Behavior</h2>
            </div>

            <label className={styles.toggleRow}>
              <span className={styles.toggleDescription}>
                <strong>Always show extra controls</strong>
                <span>Keep lyrics and queue visible instead of showing them only on hover.</span>
              </span>
              <input
                className={styles.toggleInput}
                type="checkbox"
                checked={extraPlayerControlsAlwaysVisible}
                onChange={(event) => setExtraPlayerControlsAlwaysVisible(event.target.checked)}
              />
              <span className={styles.toggle} aria-hidden="true" />
            </label>
          </section>
        </div>
      )}

    </main>
  );
}
