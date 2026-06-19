// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(not(debug_assertions))]
use portpicker::pick_unused_port;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(not(debug_assertions))]
use tauri::utils::config::FrontendDist;
#[cfg(not(debug_assertions))]
use tauri::utils::config_v1::WindowUrl;

use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
#[cfg(target_os = "macos")]
use rand::{rngs::OsRng, RngCore};

#[cfg(target_os = "windows")]
mod windows_media;

mod discord_rpc;

// Keep the legacy service name so existing sign-in credentials survive the product rename.
const KEYRING_SERVICE: &str = "com.ytmusicdock.app";
const KEYRING_USER: &str = "youtube-oauth";
const YOUTUBE_COOKIE_KEYRING_USER: &str = "youtube-music-cookie";
#[cfg(target_os = "macos")]
const YOUTUBE_COOKIE_ENCRYPTION_KEY_USER: &str = "youtube-music-cookie-encryption-key-v1";
#[cfg(target_os = "macos")]
const YOUTUBE_COOKIE_ENCRYPTED_FILE: &str = "youtube-music-session-v1.bin";
const YOUTUBE_LOGIN_WINDOW: &str = "youtube-music-login";
const YOUTUBE_LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";
const YOUTUBE_PLAYER_API_URL: &str = "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false";
const YOUTUBE_MUSIC_PLAYER_API_URL: &str = "https://music.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false";
#[cfg(target_os = "macos")]
const MACOS_LOGIN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const YOUTUBE_COOKIE_CHUNK_SIZE: usize = 900;
const YOUTUBE_COOKIE_MAX_CHUNKS: usize = 16;
const DEFAULT_CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

struct CacheLock(Mutex<()>);
struct AppSettingsLock(Mutex<()>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheSettings {
    max_bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    key: String,
    value: String,
    updated_at_ms: u64,
    last_accessed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStats {
    max_bytes: u64,
    used_bytes: u64,
    entry_count: usize,
}

#[derive(Serialize)]
struct CacheWriteResult {
    changed: bool,
}

fn cache_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("data-cache-v1"))
        .map_err(|error| cache_error(format!("cache directory unavailable: {error}")))
}

fn cache_entries_dir(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    Ok(cache_root(app)?.join("entries"))
}

fn cache_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    Ok(cache_root(app)?.join("settings.json"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn cache_key_hash(key: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn cache_entry_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, CommandError> {
    Ok(cache_entries_dir(app)?.join(format!("{:016x}.json", cache_key_hash(key))))
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| cache_error(format!("cache directory creation failed: {error}")))?;
    }
    let bytes = serde_json::to_vec(value)
        .map_err(|error| cache_error(format!("cache serialization failed: {error}")))?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, bytes)
        .map_err(|error| cache_error(format!("cache write failed: {error}")))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| cache_error(format!("cache replacement failed: {error}")))?;
    }
    fs::rename(&temp_path, path)
        .map_err(|error| cache_error(format!("cache finalize failed: {error}")))
}

fn app_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("settings-v1.json"))
        .map_err(|error| CommandError {
            message: format!("application settings directory unavailable: {error}"),
        })
}

fn read_app_settings(
    app: &tauri::AppHandle,
) -> Result<HashMap<String, serde_json::Value>, CommandError> {
    let path = app_settings_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let bytes = fs::read(path).map_err(|error| CommandError {
        message: format!("application settings read failed: {error}"),
    })?;
    serde_json::from_slice(&bytes).map_err(|error| CommandError {
        message: format!("application settings parse failed: {error}"),
    })
}

#[tauri::command]
fn app_setting_get(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
    key: String,
) -> Result<Option<serde_json::Value>, CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    Ok(read_app_settings(&app)?.remove(&key))
}

#[tauri::command]
fn app_setting_set(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
    key: String,
    value: serde_json::Value,
) -> Result<(), CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    let mut settings = read_app_settings(&app)?;
    settings.insert(key, value);
    write_json_file(&app_settings_path(&app)?, &settings)
}

#[tauri::command]
fn app_setting_remove(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
    key: String,
) -> Result<(), CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    let mut settings = read_app_settings(&app)?;
    settings.remove(&key);
    write_json_file(&app_settings_path(&app)?, &settings)
}

fn read_cache_settings(app: &tauri::AppHandle) -> Result<CacheSettings, CommandError> {
    let path = cache_settings_path(app)?;
    if !path.exists() {
        return Ok(CacheSettings {
            max_bytes: DEFAULT_CACHE_MAX_BYTES,
        });
    }
    let bytes = fs::read(path)
        .map_err(|error| cache_error(format!("cache settings read failed: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| cache_error(format!("cache settings parse failed: {error}")))
}

fn cache_files(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, CommandError> {
    let directory = cache_entries_dir(app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let files = fs::read_dir(directory)
        .map_err(|error| cache_error(format!("cache directory read failed: {error}")))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    Ok(files)
}

fn read_cache_entry(path: &Path) -> Result<CacheEntry, CommandError> {
    let bytes =
        fs::read(path).map_err(|error| cache_error(format!("cache entry read failed: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| cache_error(format!("cache entry parse failed: {error}")))
}

fn calculate_cache_stats(app: &tauri::AppHandle) -> Result<CacheStats, CommandError> {
    let files = cache_files(app)?;
    let used_bytes = files
        .iter()
        .filter_map(|path| fs::metadata(path).ok().map(|metadata| metadata.len()))
        .sum();
    Ok(CacheStats {
        max_bytes: read_cache_settings(app)?.max_bytes,
        used_bytes,
        entry_count: files.len(),
    })
}

fn enforce_cache_limit(app: &tauri::AppHandle) -> Result<(), CommandError> {
    let max_bytes = read_cache_settings(app)?.max_bytes;
    let mut entries = cache_files(app)?
        .into_iter()
        .filter_map(|path| {
            let size = fs::metadata(&path).ok()?.len();
            let last_accessed_ms = read_cache_entry(&path).ok()?.last_accessed_ms;
            Some((path, size, last_accessed_ms))
        })
        .collect::<Vec<_>>();
    let mut used_bytes = entries.iter().map(|(_, size, _)| *size).sum::<u64>();
    entries.sort_by_key(|(_, _, last_accessed_ms)| *last_accessed_ms);

    for (path, size, _) in entries {
        if used_bytes <= max_bytes {
            break;
        }
        if fs::remove_file(path).is_ok() {
            used_bytes = used_bytes.saturating_sub(size);
        }
    }
    Ok(())
}

#[tauri::command]
fn cache_get(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    key: String,
) -> Result<Option<String>, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    let path = cache_entry_path(&app, &key)?;
    if !path.exists() {
        return Ok(None);
    }
    let mut entry = match read_cache_entry(&path) {
        Ok(entry) if entry.key == key => entry,
        Ok(_) => return Ok(None),
        Err(_) => {
            let _ = fs::remove_file(path);
            return Ok(None);
        }
    };
    entry.last_accessed_ms = now_ms();
    let value = entry.value.clone();
    write_json_file(&path, &entry)?;
    Ok(Some(value))
}

#[tauri::command]
fn cache_set(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    key: String,
    value: String,
) -> Result<CacheWriteResult, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    let path = cache_entry_path(&app, &key)?;
    let existing = if path.exists() {
        read_cache_entry(&path)
            .ok()
            .filter(|entry| entry.key == key)
    } else {
        None
    };
    let changed = existing.as_ref().map_or(true, |entry| entry.value != value);
    let timestamp = now_ms();
    let entry = CacheEntry {
        key,
        value,
        updated_at_ms: if changed {
            timestamp
        } else {
            existing
                .as_ref()
                .map(|entry| entry.updated_at_ms)
                .unwrap_or(timestamp)
        },
        last_accessed_ms: timestamp,
    };
    write_json_file(&path, &entry)?;
    enforce_cache_limit(&app)?;
    Ok(CacheWriteResult { changed })
}

#[tauri::command]
fn cache_stats(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
) -> Result<CacheStats, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    calculate_cache_stats(&app)
}

#[tauri::command]
fn cache_set_max_bytes(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    max_bytes: u64,
) -> Result<CacheStats, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    write_json_file(&cache_settings_path(&app)?, &CacheSettings { max_bytes })?;
    enforce_cache_limit(&app)?;
    calculate_cache_stats(&app)
}

#[tauri::command]
fn cache_clear(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
) -> Result<CacheStats, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    let entries = cache_entries_dir(&app)?;
    if entries.exists() {
        fs::remove_dir_all(&entries)
            .map_err(|error| cache_error(format!("cache clear failed: {error}")))?;
    }
    fs::create_dir_all(entries)
        .map_err(|error| cache_error(format!("cache directory creation failed: {error}")))?;
    calculate_cache_stats(&app)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    eprintln!("[internal][tauri][info] quit_app invoked");
    app.exit(0);
}

#[tauri::command]
fn frontend_log(level: String, context: String, payload: String) {
    eprintln!("[internal][frontend][{}] {} {}", level, context, payload);
}

fn youtube_keyring_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| CommandError {
        message: format!("credential store unavailable: {error}"),
    })
}

fn youtube_cookie_keyring_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, YOUTUBE_COOKIE_KEYRING_USER).map_err(|error| {
        CommandError {
            message: format!("credential store unavailable: {error}"),
        }
    })
}

fn youtube_cookie_chunk_entry(index: usize) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(
        KEYRING_SERVICE,
        &format!("{YOUTUBE_COOKIE_KEYRING_USER}-{index}"),
    )
    .map_err(|error| CommandError {
        message: format!("credential store unavailable: {error}"),
    })
}

fn save_youtube_music_cookie_entries(cookie: &str) -> Result<(), CommandError> {
    let chunks = cookie
        .as_bytes()
        .chunks(YOUTUBE_COOKIE_CHUNK_SIZE)
        .map(|chunk| std::str::from_utf8(chunk).expect("YouTube cookie header must be UTF-8"))
        .collect::<Vec<_>>();

    if chunks.len() > YOUTUBE_COOKIE_MAX_CHUNKS {
        return Err(CommandError {
            message: "YouTube Music session is too large for secure storage.".to_string(),
        });
    }

    eprintln!(
        "[internal][tauri][info] save_youtube_music_cookie chunks={} bytes={}",
        chunks.len(),
        cookie.len()
    );
    delete_youtube_music_cookie_entries()?;
    for (index, chunk) in chunks.iter().enumerate() {
        youtube_cookie_chunk_entry(index)?
            .set_password(chunk)
            .map_err(|error| CommandError {
                message: format!("YouTube Music session chunk {index} save failed: {error}"),
            })?;
    }
    youtube_cookie_keyring_entry()?
        .set_password(&format!("chunks:{}", chunks.len()))
        .map_err(|error| CommandError {
            message: format!("YouTube Music session manifest save failed: {error}"),
        })?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn youtube_cookie_encryption_key_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, YOUTUBE_COOKIE_ENCRYPTION_KEY_USER).map_err(|error| {
        CommandError {
            message: format!("credential store unavailable: {error}"),
        }
    })
}

#[cfg(target_os = "macos")]
fn youtube_cookie_encrypted_file(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(YOUTUBE_COOKIE_ENCRYPTED_FILE))
        .map_err(|error| CommandError {
            message: format!("application data directory unavailable: {error}"),
        })
}

#[cfg(target_os = "macos")]
fn load_or_create_cookie_encryption_key() -> Result<[u8; 32], CommandError> {
    let entry = youtube_cookie_encryption_key_entry()?;
    match entry.get_password() {
        Ok(encoded) => {
            let decoded = STANDARD.decode(encoded).map_err(|error| CommandError {
                message: format!("stored session encryption key is invalid: {error}"),
            })?;
            decoded.try_into().map_err(|_| CommandError {
                message: "stored session encryption key has an invalid length.".to_string(),
            })
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0_u8; 32];
            OsRng.fill_bytes(&mut key);
            entry
                .set_password(&STANDARD.encode(key))
                .map_err(|error| CommandError {
                    message: format!("session encryption key save failed: {error}"),
                })?;
            Ok(key)
        }
        Err(error) => Err(CommandError {
            message: format!("session encryption key load failed: {error}"),
        }),
    }
}

#[cfg(target_os = "macos")]
fn save_youtube_music_cookie(app: &tauri::AppHandle, cookie: &str) -> Result<(), CommandError> {
    let key = load_or_create_cookie_encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| CommandError {
        message: format!("session encryption setup failed: {error}"),
    })?;
    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), cookie.as_bytes())
        .map_err(|error| CommandError {
            message: format!("session encryption failed: {error}"),
        })?;

    let path = youtube_cookie_encrypted_file(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| CommandError {
            message: format!("session directory creation failed: {error}"),
        })?;
    }
    let mut contents = Vec::with_capacity(nonce_bytes.len() + encrypted.len());
    contents.extend_from_slice(&nonce_bytes);
    contents.extend_from_slice(&encrypted);
    fs::write(path, contents).map_err(|error| CommandError {
        message: format!("encrypted session save failed: {error}"),
    })
}

#[cfg(not(target_os = "macos"))]
fn save_youtube_music_cookie(_app: &tauri::AppHandle, cookie: &str) -> Result<(), CommandError> {
    save_youtube_music_cookie_entries(cookie)
}

fn delete_youtube_music_cookie_entries() -> Result<(), CommandError> {
    match youtube_cookie_keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => {
            return Err(CommandError {
                message: format!("YouTube Music session manifest delete failed: {error}"),
            });
        }
    }

    for index in 0..YOUTUBE_COOKIE_MAX_CHUNKS {
        match youtube_cookie_chunk_entry(index)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(CommandError {
                    message: format!("YouTube Music session chunk {index} delete failed: {error}"),
                });
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn save_youtube_credentials(credentials_json: String) -> Result<(), CommandError> {
    youtube_keyring_entry()?
        .set_password(&credentials_json)
        .map_err(|error| CommandError {
            message: format!("credential save failed: {error}"),
        })
}

#[tauri::command]
fn load_youtube_credentials() -> Result<Option<String>, CommandError> {
    match youtube_keyring_entry()?.get_password() {
        Ok(credentials) => Ok(Some(credentials)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(CommandError {
            message: format!("credential load failed: {error}"),
        }),
    }
}

#[tauri::command]
fn delete_youtube_credentials() -> Result<(), CommandError> {
    match youtube_keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(CommandError {
            message: format!("credential delete failed: {error}"),
        }),
    }
}

fn load_youtube_music_cookie_entries() -> Result<Option<String>, CommandError> {
    match youtube_cookie_keyring_entry()?.get_password() {
        Ok(manifest) if manifest.starts_with("chunks:") => {
            let chunk_count = manifest
                .trim_start_matches("chunks:")
                .parse::<usize>()
                .map_err(|error| CommandError {
                    message: format!("invalid YouTube Music session manifest: {error}"),
                })?;
            if chunk_count == 0 || chunk_count > YOUTUBE_COOKIE_MAX_CHUNKS {
                return Err(CommandError {
                    message: "invalid YouTube Music session chunk count.".to_string(),
                });
            }

            let mut cookie = String::new();
            for index in 0..chunk_count {
                let chunk = youtube_cookie_chunk_entry(index)?
                    .get_password()
                    .map_err(|error| CommandError {
                        message: format!(
                            "YouTube Music session chunk {index} load failed: {error}"
                        ),
                    })?;
                cookie.push_str(&chunk);
            }
            eprintln!(
                "[internal][tauri][info] load_youtube_music_cookie assembled chunks={} bytes={}",
                chunk_count,
                cookie.len(),
            );
            Ok(Some(cookie))
        }
        Ok(cookie) => {
            eprintln!(
                "[internal][tauri][info] load_youtube_music_cookie found legacy credential bytes={}",
                cookie.len()
            );
            Ok(Some(cookie))
        }
        Err(keyring::Error::NoEntry) => {
            eprintln!("[internal][tauri][info] load_youtube_music_cookie no credential");
            Ok(None)
        }
        Err(error) => Err(CommandError {
            message: format!("YouTube Music session load failed: {error}"),
        }),
    }
}

#[cfg(target_os = "macos")]
fn load_encrypted_youtube_music_cookie(
    app: &tauri::AppHandle,
) -> Result<Option<String>, CommandError> {
    let path = youtube_cookie_encrypted_file(app)?;
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CommandError {
                message: format!("encrypted session load failed: {error}"),
            })
        }
    };
    if contents.len() <= 12 {
        return Err(CommandError {
            message: "encrypted session file is invalid.".to_string(),
        });
    }
    let key = load_or_create_cookie_encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| CommandError {
        message: format!("session decryption setup failed: {error}"),
    })?;
    let decrypted = cipher
        .decrypt(Nonce::from_slice(&contents[..12]), &contents[12..])
        .map_err(|error| CommandError {
            message: format!("session decryption failed: {error}"),
        })?;
    String::from_utf8(decrypted)
        .map(Some)
        .map_err(|error| CommandError {
            message: format!("decrypted session is invalid: {error}"),
        })
}

#[tauri::command]
fn load_youtube_music_cookie(app: tauri::AppHandle) -> Result<Option<String>, CommandError> {
    #[cfg(target_os = "macos")]
    {
        if let Some(cookie) = load_encrypted_youtube_music_cookie(&app)? {
            return Ok(Some(cookie));
        }
        if let Some(cookie) = load_youtube_music_cookie_entries()? {
            save_youtube_music_cookie(&app, &cookie)?;
            delete_youtube_music_cookie_entries()?;
            return Ok(Some(cookie));
        }
        return Ok(None);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        load_youtube_music_cookie_entries()
    }
}

#[cfg(any(target_os = "macos", test))]
fn cookie_domain_matches(host: &str, cookie_domain: Option<&str>) -> bool {
    let Some(cookie_domain) = cookie_domain else {
        return false;
    };
    let cookie_domain = cookie_domain.trim_start_matches('.');

    host.eq_ignore_ascii_case(cookie_domain)
        || host
            .strip_suffix(cookie_domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

#[tauri::command]
async fn sign_in_youtube_music(app: tauri::AppHandle) -> Result<String, CommandError> {
    eprintln!("[internal][tauri][info] sign_in_youtube_music start");
    if let Some(existing) = app.get_webview_window(YOUTUBE_LOGIN_WINDOW) {
        eprintln!("[internal][tauri][info] sign_in_youtube_music closing existing login window");
        let _ = existing.close();
    }

    let login_url = YOUTUBE_LOGIN_URL.parse().map_err(|error| CommandError {
        message: format!("invalid YouTube Music sign-in URL: {error}"),
    })?;
    let blank_url = "about:blank".parse().map_err(|error| CommandError {
        message: format!("invalid blank login URL: {error}"),
    })?;
    let window_builder = tauri::WebviewWindowBuilder::new(
        &app,
        YOUTUBE_LOGIN_WINDOW,
        tauri::WebviewUrl::External(blank_url),
    )
    .title("Sign in to YouTube Music")
    .inner_size(520.0, 760.0);
    #[cfg(target_os = "macos")]
    let window_builder = window_builder.user_agent(MACOS_LOGIN_USER_AGENT);
    let window = window_builder.build().map_err(|error| CommandError {
        message: format!("unable to open YouTube Music sign-in: {error}"),
    })?;
    eprintln!("[internal][tauri][info] sign_in_youtube_music login window created");
    window
        .clear_all_browsing_data()
        .map_err(|error| CommandError {
            message: format!("unable to clear previous YouTube Music sign-in data: {error}"),
        })?;
    eprintln!("[internal][tauri][info] sign_in_youtube_music cleared login webview data");
    window.navigate(login_url).map_err(|error| CommandError {
        message: format!("unable to navigate to YouTube Music sign-in: {error}"),
    })?;
    eprintln!("[internal][tauri][info] sign_in_youtube_music navigated to Google sign-in");

    #[cfg(not(target_os = "macos"))]
    let cookie_url: url::Url =
        "https://music.youtube.com/"
            .parse()
            .map_err(|error| CommandError {
                message: format!("invalid YouTube Music cookie URL: {error}"),
            })?;

    for poll in 1..=300 {
        #[cfg(target_os = "macos")]
        let cookies = window
            .cookies()
            .map_err(|error| CommandError {
                message: format!("unable to read YouTube Music session: {error}"),
            })?
            .into_iter()
            .filter(|cookie| cookie_domain_matches("music.youtube.com", cookie.domain()))
            .collect::<Vec<_>>();
        #[cfg(not(target_os = "macos"))]
        let cookies = window
            .cookies_for_url(cookie_url.clone())
            .map_err(|error| CommandError {
                message: format!("unable to read YouTube Music session: {error}"),
            })?;
        let cookie_names = cookies
            .iter()
            .map(|cookie| cookie.name())
            .collect::<std::collections::HashSet<_>>();
        let has_auth_cookie = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]
            .iter()
            .any(|name| cookie_names.contains(name));
        let on_music_page = window
            .url()
            .map(|url| url.domain() == Some("music.youtube.com"))
            .unwrap_or(false);
        let signed_in = has_auth_cookie && on_music_page;
        let current_url = window
            .url()
            .map(|url| url.to_string())
            .unwrap_or_else(|error| format!("[url unavailable: {error}]"));
        let cookie_metadata = cookies
            .iter()
            .map(|cookie| {
                format!(
                    "{}(domain={:?},path={:?},secure={:?},http_only={:?})",
                    cookie.name(),
                    cookie.domain(),
                    cookie.path(),
                    cookie.secure(),
                    cookie.http_only()
                )
            })
            .collect::<Vec<_>>();
        eprintln!(
            "[internal][tauri][debug] sign_in_youtube_music poll={} url={} cookie_count={} cookies={:?} has_auth_cookie={} on_music_page={} signed_in={}",
            poll,
            current_url,
            cookies.len(),
            cookie_metadata,
            has_auth_cookie,
            on_music_page,
            signed_in
        );

        if signed_in {
            let cookie_header = cookies
                .iter()
                .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                .collect::<Vec<_>>()
                .join("; ");
            eprintln!(
                "[internal][tauri][info] sign_in_youtube_music detected session poll={} cookie_count={} credential_bytes={}",
                poll,
                cookies.len(),
                cookie_header.len()
            );
            save_youtube_music_cookie(&app, &cookie_header)?;
            eprintln!("[internal][tauri][info] sign_in_youtube_music credential saved");
            let _ = window.close();
            eprintln!("[internal][tauri][info] sign_in_youtube_music login window close requested");
            return Ok(cookie_header);
        }

        if app.get_webview_window(YOUTUBE_LOGIN_WINDOW).is_none() {
            eprintln!(
                "[internal][tauri][warn] sign_in_youtube_music cancelled poll={}",
                poll
            );
            return Err(CommandError {
                message: "YouTube Music sign-in was cancelled.".to_string(),
            });
        }
        thread::sleep(Duration::from_secs(1));
    }

    let _ = window.close();
    eprintln!("[internal][tauri][warn] sign_in_youtube_music timed out");
    Err(CommandError {
        message: "YouTube Music sign-in timed out.".to_string(),
    })
}

#[tauri::command]
async fn delete_youtube_music_cookie(app: tauri::AppHandle) -> Result<(), CommandError> {
    eprintln!("[internal][tauri][info] delete_youtube_music_cookie start");
    if let Some(window) = app.get_webview_window(YOUTUBE_LOGIN_WINDOW) {
        let _ = window.clear_all_browsing_data();
        let _ = window.close();
    }

    #[cfg(target_os = "macos")]
    {
        let path = youtube_cookie_encrypted_file(&app)?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CommandError {
                    message: format!("encrypted session delete failed: {error}"),
                })
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    delete_youtube_music_cookie_entries()?;
    eprintln!("[internal][tauri][info] delete_youtube_music_cookie complete");
    Ok(())
}

#[derive(Serialize)]
struct CommandError {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioPayload {
    body_base64: String,
    mime_type: String,
}

#[derive(serde::Deserialize)]
struct ProxyHttpRequestInput {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body_base64: Option<String>,
}

#[derive(Serialize)]
struct ProxyHttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body_base64: String,
}

fn collect_json_renderer_counts(value: &serde_json::Value, counts: &mut HashMap<String, usize>) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if key.ends_with("Renderer")
                    || key.ends_with("Continuation")
                    || key.ends_with("Command")
                {
                    *counts.entry(key.clone()).or_default() += 1;
                }
                collect_json_renderer_counts(child, counts);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_renderer_counts(item, counts);
            }
        }
        _ => {}
    }
}

fn collect_message_text(value: &serde_json::Value, messages: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(renderer) = object
                .get("messageRenderer")
                .and_then(|value| value.as_object())
            {
                for field in ["text", "subtext"] {
                    if let Some(runs) = renderer
                        .get(field)
                        .and_then(|value| value.get("runs"))
                        .and_then(|value| value.as_array())
                    {
                        let text = runs
                            .iter()
                            .filter_map(|run| run.get("text").and_then(|value| value.as_str()))
                            .collect::<String>();
                        if !text.is_empty() {
                            messages.push(text);
                        }
                    }
                }
            }
            for child in object.values() {
                collect_message_text(child, messages);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_message_text(item, messages);
            }
        }
        _ => {}
    }
}

#[tauri::command]
async fn fetch_audio_bytes(url: String, track_id: String) -> Result<Vec<u8>, CommandError> {
    let started_at = Instant::now();
    eprintln!(
        "[internal][tauri][info] fetch_audio_bytes start url={} track_id={}",
        url, track_id
    );
    let response = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept-Encoding", "identity;q=1, *;q=0")
        .header("Range", "bytes=0-")
        .header("Origin", "https://www.youtube.com")
        .header("Referer", &format!("https://www.youtube.com/watch?v={}", track_id))
        .header("Sec-Fetch-Dest", "audio")
        .header("Sec-Fetch-Mode", "no-cors")
        .header("Sec-Fetch-Site", "cross-site")
        .send()
        .await
        .map_err(|error| {
            eprintln!(
                "[internal][tauri][error] fetch_audio_bytes request failed url={} error={}",
                url, error
            );
            CommandError {
                message: format!("request failed: {error}"),
            }
        })?;

    if !response.status().is_success() {
        eprintln!(
            "[internal][tauri][warn] fetch_audio_bytes non-success url={} status={}",
            url,
            response.status()
        );
        return Err(CommandError {
            message: format!("request returned {}", response.status()),
        });
    }

    let body = response.bytes().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] fetch_audio_bytes body read failed url={} error={}",
            url, error
        );
        CommandError {
            message: format!("read body failed: {error}"),
        }
    })?;

    eprintln!(
        "[internal][tauri][info] fetch_audio_bytes success url={} bytes={} duration_ms={}",
        url,
        body.len(),
        started_at.elapsed().as_millis()
    );

    Ok(body.to_vec())
}

#[tauri::command]
async fn fetch_youtube_music_audio(video_id: String) -> Result<AudioPayload, CommandError> {
    let started_at = Instant::now();
    eprintln!(
        "[internal][tauri][info] fetch_youtube_music_audio start video_id={}",
        video_id
    );

    let client = reqwest::Client::new();

    // Mobile and TV clients are preferred because they are more likely to
    // return direct media URLs that do not require player-JavaScript deciphering.
    let api_attempts = vec![
        ("YouTube iOS", YOUTUBE_PLAYER_API_URL, create_ios_context()),
        (
            "YouTube ANDROID",
            YOUTUBE_PLAYER_API_URL,
            create_android_context(),
        ),
        ("YouTube TV", YOUTUBE_PLAYER_API_URL, create_tv_context()),
        ("YouTube WEB", YOUTUBE_PLAYER_API_URL, create_web_context()),
        (
            "YouTube Music WEB_REMIX",
            YOUTUBE_MUSIC_PLAYER_API_URL,
            create_web_remix_context(),
        ),
    ];

    let mut failures = Vec::new();
    for (attempt_name, api_url, context) in api_attempts {
        eprintln!(
            "[internal][tauri][info] fetch_youtube_music_audio trying {} video_id={}",
            attempt_name, video_id
        );

        match try_youtube_api(&client, &api_url, &context, &video_id, &attempt_name).await {
            Ok(audio_bytes) => {
                eprintln!(
                    "[internal][tauri][info] fetch_youtube_music_audio success video_id={} attempt={} bytes={} duration_ms={}",
                    video_id,
                    attempt_name,
                    audio_bytes.body_base64.len(),
                    started_at.elapsed().as_millis()
                );
                return Ok(audio_bytes);
            }
            Err(error) => {
                eprintln!(
                    "[internal][tauri][error] fetch_youtube_music_audio attempt failed video_id={} attempt={} error={}",
                    video_id, attempt_name, error.message
                );
                failures.push(format!("{attempt_name}: {}", error.message));
            }
        }
    }

    eprintln!(
        "[internal][tauri][error] fetch_youtube_music_audio all attempts failed video_id={}",
        video_id
    );
    Err(CommandError {
        message: format!("all YouTube API attempts failed: {}", failures.join("; ")),
    })
}

fn create_web_remix_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": "1.20250506.00.00",
            "hl": "en",
            "gl": "US",
            "platform": "DESKTOP",
            "osName": "Windows",
            "osVersion": "10.0",
            "browserName": "Chrome",
            "browserVersion": "135.0.0.0",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
        }
    })
}

fn create_web_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "WEB",
            "clientVersion": "2.20260206.01.00",
            "hl": "en",
            "gl": "US",
            "platform": "DESKTOP",
            "osName": "Windows",
            "osVersion": "10.0",
            "browserName": "Chrome",
            "browserVersion": "135.0.0.0",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
        }
    })
}

fn create_ios_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "IOS",
            "clientVersion": "20.11.6",
            "hl": "en",
            "gl": "US",
            "deviceModel": "iPhone10,4",
            "osName": "iPhone",
            "osVersion": "16.7.7.20H330",
            "userAgent": "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)"
        }
    })
}

fn create_android_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "ANDROID",
            "clientVersion": "21.03.36",
            "hl": "en",
            "gl": "US",
            "platform": "MOBILE",
            "osName": "Android",
            "osVersion": "16",
            "androidSdkVersion": 36,
            "userAgent": "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip"
        }
    })
}

fn create_tv_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "TVHTML5",
            "clientVersion": "7.20260311.12.00",
            "hl": "en",
            "gl": "US",
            "platform": "TV",
            "osName": "Linux",
            "userAgent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"
        }
    })
}

async fn try_youtube_api(
    client: &reqwest::Client,
    api_url: &str,
    context: &serde_json::Value,
    video_id: &str,
    attempt_name: &str,
) -> Result<AudioPayload, CommandError> {
    let request_body = serde_json::json!({
        "context": context,
        "videoId": video_id,
        "racyCheckOk": true,
        "contentCheckOk": true
    });

    let request_body_str = serde_json::to_string(&request_body).map_err(|error| CommandError {
        message: format!("json serialize failed: {error}"),
    })?;

    let referer = if attempt_name.contains("Music") {
        "https://music.youtube.com/"
    } else {
        "https://www.youtube.com/"
    };

    let user_agent = if attempt_name.contains("iOS") {
        "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)"
    } else if attempt_name.contains("ANDROID") {
        "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip"
    } else if attempt_name.contains("TV") {
        "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"
    } else {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    };
    let client_name = if attempt_name.contains("iOS") {
        "5"
    } else if attempt_name.contains("ANDROID") {
        "3"
    } else if attempt_name.contains("Music") {
        "67"
    } else if attempt_name.contains("TV") {
        "7"
    } else {
        "1"
    };
    let client_version = context
        .get("client")
        .and_then(|client| client.get("clientVersion"))
        .and_then(|version| version.as_str())
        .unwrap_or_default();

    eprintln!(
        "[internal][tauri][debug] YOUTUBE API REQUEST - {} - URL: {}",
        attempt_name, api_url
    );
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API REQUEST - {} - BODY: {}",
        attempt_name, request_body_str
    );

    let response = client
        .post(api_url)
        .header("Content-Type", "application/json")
        .header("User-Agent", user_agent)
        .header("Accept", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("X-YouTube-Client-Name", client_name)
        .header("X-YouTube-Client-Version", client_version)
        .header("Referer", referer)
        .header("Origin", referer.trim_end_matches('/'))
        .body(request_body_str)
        .send()
        .await
        .map_err(|error| CommandError {
            message: format!("api request failed: {error}"),
        })?;

    let response_status = response.status();
    let response_text = response.text().await.map_err(|error| CommandError {
        message: format!("response read failed: {error}"),
    })?;
    if !response_status.is_success() {
        let response_preview = response_text.chars().take(500).collect::<String>();
        return Err(CommandError {
            message: format!("api request returned {response_status}: {response_preview}"),
        });
    }

    // LOG THE ENTIRE YOUTUBE API RESPONSE
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - START",
        attempt_name
    );
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - RAW RESPONSE LENGTH: {}",
        attempt_name,
        response_text.len()
    );
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - COMPLETE RESPONSE TEXT:\n{}",
        attempt_name, response_text
    );
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - END",
        attempt_name
    );

    let response_json: serde_json::Value =
        serde_json::from_str(&response_text).map_err(|error| CommandError {
            message: format!("json parse failed: {error}"),
        })?;
    let visitor_data = response_json
        .get("responseContext")
        .and_then(|context| context.get("visitorData"))
        .and_then(|value| value.as_str());

    // LOG PARSED RESPONSE STRUCTURE
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - PARSED STRUCTURE",
        attempt_name
    );
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - TOP LEVEL KEYS: {:?}",
        attempt_name,
        response_json
            .as_object()
            .map(|obj| obj.keys().collect::<Vec<_>>())
            .unwrap_or_default()
    );

    // Check for playability status first
    if let Some(playability_status) = response_json.get("playabilityStatus") {
        eprintln!(
            "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - PLAYABILITY STATUS: {}",
            attempt_name,
            serde_json::to_string_pretty(playability_status).unwrap_or_default()
        );

        if let Some(status) = playability_status.get("status").and_then(|s| s.as_str()) {
            if status != "OK" {
                let reason = playability_status
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .unwrap_or("Unknown reason");
                eprintln!(
                    "[internal][tauri][warn] YOUTUBE API RESPONSE - {} - VIDEO NOT PLAYABLE: status={}, reason={}",
                    attempt_name, status, reason
                );
                return Err(CommandError {
                    message: format!("video not playable: {} - {}", status, reason),
                });
            }
        }
    }

    // Check for video details
    if let Some(video_details) = response_json.get("videoDetails") {
        eprintln!(
            "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - VIDEO DETAILS: {}",
            attempt_name,
            serde_json::to_string_pretty(video_details).unwrap_or_default()
        );
    }

    // Check for streaming data existence
    let has_streaming_data = response_json.get("streamingData").is_some();
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - HAS STREAMING DATA: {}",
        attempt_name, has_streaming_data
    );

    if has_streaming_data {
        if let Some(streaming_data) = response_json.get("streamingData") {
            eprintln!(
                "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - STREAMING DATA KEYS: {:?}",
                attempt_name,
                streaming_data
                    .as_object()
                    .map(|obj| obj.keys().collect::<Vec<_>>())
                    .unwrap_or_default()
            );

            // Log adaptive formats if they exist
            if let Some(adaptive_formats) = streaming_data.get("adaptiveFormats") {
                if let Some(formats_array) = adaptive_formats.as_array() {
                    eprintln!(
                        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - ADAPTIVE FORMATS COUNT: {}",
                        attempt_name,
                        formats_array.len()
                    );

                    // Log first few formats in detail
                    for (i, format) in formats_array.iter().take(5).enumerate() {
                        eprintln!(
                            "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - FORMAT {}: {}",
                            attempt_name,
                            i,
                            serde_json::to_string_pretty(format).unwrap_or_default()
                        );
                    }

                    // Count audio vs video formats
                    let mut audio_count = 0;
                    let mut video_count = 0;
                    let mut audio_with_url = 0;
                    let mut video_with_url = 0;

                    for format in formats_array {
                        if let Some(format_obj) = format.as_object() {
                            if let Some(mime_type) =
                                format_obj.get("mimeType").and_then(|m| m.as_str())
                            {
                                if mime_type.contains("audio") {
                                    audio_count += 1;
                                    if format_obj.get("url").is_some() {
                                        audio_with_url += 1;
                                    }
                                } else if mime_type.contains("video") {
                                    video_count += 1;
                                    if format_obj.get("url").is_some() {
                                        video_with_url += 1;
                                    }
                                }
                            }
                        }
                    }

                    eprintln!(
                        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - FORMAT SUMMARY: audio_total={}, audio_with_url={}, video_total={}, video_with_url={}",
                        attempt_name,
                        audio_count,
                        audio_with_url,
                        video_count,
                        video_with_url
                    );
                }
            }

            // Log regular formats if they exist
            if let Some(formats) = streaming_data.get("formats") {
                if let Some(formats_array) = formats.as_array() {
                    eprintln!(
                        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - REGULAR FORMATS COUNT: {}",
                        attempt_name,
                        formats_array.len()
                    );
                }
            }
        }
    }

    // Look for streaming data in the response
    let streaming_data = response_json
        .get("streamingData")
        .and_then(|sd| sd.get("adaptiveFormats"))
        .and_then(|af| af.as_array())
        .ok_or_else(|| {
            eprintln!(
                "[internal][tauri][error] YOUTUBE API RESPONSE - {} - NO STREAMING DATA FOUND",
                attempt_name
            );
            CommandError {
                message: "no streaming data found".to_string(),
            }
        })?;

    // Ciphered formats require YouTube's player JavaScript. This backend only
    // accepts direct URLs instead of sending an invalid encrypted signature.
    let mut best_audio_url: Option<String> = None;
    let mut best_mime_type: Option<String> = None;
    let mut best_is_mp4 = false;
    let mut best_bitrate: u32 = 0;

    for format in streaming_data {
        if let Some(format_obj) = format.as_object() {
            if let (Some(mime_type), Some(bitrate)) = (
                format_obj.get("mimeType"),
                format_obj.get("bitrate").and_then(|b| b.as_u64()),
            ) {
                if let Some(mime_str) = mime_type.as_str() {
                    let is_mp4 = mime_str.starts_with("audio/mp4");
                    let is_better = is_mp4 && !best_is_mp4
                        || is_mp4 == best_is_mp4 && bitrate > best_bitrate as u64;
                    if mime_str.starts_with("audio/") && is_better {
                        if let Some(url) = format_obj.get("url").and_then(|u| u.as_str()) {
                            best_audio_url = Some(url.to_string());
                            best_mime_type = Some(
                                mime_str
                                    .split(';')
                                    .next()
                                    .unwrap_or("audio/mp4")
                                    .to_string(),
                            );
                            best_is_mp4 = is_mp4;
                            best_bitrate = bitrate as u32;
                        }
                    }
                }
            }
        }
    }

    let audio_url = best_audio_url.ok_or_else(|| CommandError {
        message: "no suitable audio format found".to_string(),
    })?;
    let mime_type = best_mime_type.unwrap_or_else(|| "audio/mp4".to_string());

    eprintln!(
        "[internal][tauri][debug] Attempting to download audio from URL (first 200 chars): {}",
        audio_url.chars().take(200).collect::<String>()
    );

    // Download the audio
    let mut audio_request = client
        .get(&audio_url)
        .header("User-Agent", user_agent)
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept-Encoding", "identity;q=1, *;q=0")
        .header("Range", "bytes=0-");

    if let Some(visitor_data) = visitor_data {
        audio_request = audio_request.header("X-Goog-Visitor-Id", visitor_data);
    }

    if !attempt_name.contains("iOS") && !attempt_name.contains("ANDROID") {
        audio_request = audio_request
            .header("Referer", referer)
            .header("Origin", referer.trim_end_matches('/'))
            .header("Sec-Fetch-Dest", "audio")
            .header("Sec-Fetch-Mode", "no-cors")
            .header("Sec-Fetch-Site", "cross-site");
    }

    let audio_response = audio_request.send().await.map_err(|error| CommandError {
        message: format!("download failed: {error}"),
    })?;

    if !audio_response.status().is_success() {
        return Err(CommandError {
            message: format!("download returned {}", audio_response.status()),
        });
    }

    let audio_body = audio_response.bytes().await.map_err(|error| CommandError {
        message: format!("download body read failed: {error}"),
    })?;

    Ok(AudioPayload {
        body_base64: STANDARD.encode(audio_body),
        mime_type,
    })
}

#[tauri::command]
async fn proxy_http_request(
    input: ProxyHttpRequestInput,
) -> Result<ProxyHttpResponse, CommandError> {
    let started_at = Instant::now();
    let request_url = url::Url::parse(&input.url).map_err(|error| CommandError {
        message: format!("invalid URL: {error}"),
    })?;
    let request_target = format!(
        "{}://{}{}",
        request_url.scheme(),
        request_url.host_str().unwrap_or("unknown"),
        request_url.path()
    );
    eprintln!(
        "[internal][tauri][info] proxy_http_request start method={} url={} headers={} has_body={}",
        input.method,
        request_target,
        input.headers.len(),
        input.body_base64.is_some()
    );

    eprintln!("[internal][tauri][debug] proxy_http_request headers:");
    for (key, value) in &input.headers {
        let normalized_key = key.to_ascii_lowercase();
        let safe_value = if normalized_key == "authorization" || normalized_key == "cookie" {
            "[redacted]"
        } else {
            value
        };
        eprintln!("  {}: {}", key, safe_value);
    }
    let method = reqwest::Method::from_bytes(input.method.as_bytes()).map_err(|error| {
        eprintln!(
            "[internal][tauri][error] proxy_http_request invalid method={} error={}",
            input.method, error
        );
        CommandError {
            message: format!("invalid method: {error}"),
        }
    })?;

    let mut client_builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36");

    if request_url
        .host_str()
        .is_some_and(|host| host.ends_with(".googlevideo.com"))
    {
        let signed_ip = request_url.query_pairs().find_map(|(key, value)| {
            (key == "ip")
                .then(|| value.parse::<IpAddr>().ok())
                .flatten()
        });

        if let Some(signed_ip) = signed_ip {
            let local_address = match signed_ip {
                IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            };
            eprintln!(
                "[internal][tauri][info] proxy_http_request forcing signed IP family url={} family={}",
                request_target,
                if signed_ip.is_ipv6() { "ipv6" } else { "ipv4" }
            );
            client_builder = client_builder.local_address(local_address);
        }
    }

    let client = client_builder.build().map_err(|error| CommandError {
        message: format!("HTTP client creation failed: {error}"),
    })?;
    let mut request = client.request(method, &input.url);

    for (key, value) in &input.headers {
        request = request.header(key, value);
    }

    if let Some(body_base64) = input.body_base64 {
        let bytes = STANDARD.decode(body_base64).map_err(|error| {
            eprintln!(
                "[internal][tauri][error] proxy_http_request body decode failed url={} error={}",
                input.url, error
            );
            CommandError {
                message: format!("invalid body encoding: {error}"),
            }
        })?;
        request = request.body(bytes);
    }

    let response = request.send().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] proxy_http_request request failed url={} error={}",
            input.url, error
        );
        CommandError {
            message: format!("request failed: {error}"),
        }
    })?;

    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            headers.insert(key.to_string(), value_str.to_string());
        }
    }

    let body = response.bytes().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] proxy_http_request body read failed url={} error={}",
            input.url, error
        );
        CommandError {
            message: format!("read body failed: {error}"),
        }
    })?;

    if request_url.path().ends_with("/browse") && status < 400 {
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
            let top_level_keys = json
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let mut renderer_counts = HashMap::new();
            collect_json_renderer_counts(&json, &mut renderer_counts);
            let mut messages = Vec::new();
            collect_message_text(&json, &mut messages);
            eprintln!(
                "[internal][tauri][debug] proxy_http_request browse_shape top_level_keys={:?} renderer_counts={:?} messages={:?}",
                top_level_keys, renderer_counts, messages
            );
        }
    }

    if status >= 400 {
        let error_body = String::from_utf8_lossy(&body);
        eprintln!(
            "[internal][tauri][warn] proxy_http_request error_body method={} url={} status={} body={}",
            input.method,
            request_target,
            status,
            error_body.chars().take(1000).collect::<String>()
        );
    }

    eprintln!(
        "[internal][tauri][info] proxy_http_request success method={} url={} status={} bytes={} duration_ms={}",
        input.method,
        request_target,
        status,
        body.len(),
        started_at.elapsed().as_millis()
    );

    Ok(ProxyHttpResponse {
        status,
        headers,
        body_base64: STANDARD.encode(body),
    })
}

#[tauri::command]
fn discord_rpc_update(
    discord_manager: tauri::State<
        '_,
        std::sync::Arc<std::sync::Mutex<discord_rpc::DiscordRpcManager>>,
    >,
    title: String,
    artist: String,
    album: String,
    artwork_url: Option<String>,
    duration: u64,
    current_time: u64,
    is_playing: bool,
) -> Result<(), CommandError> {
    let data = discord_rpc::DiscordPresenceData {
        title,
        artist,
        album,
        artwork_url,
        duration,
        current_time,
        is_playing,
    };

    match discord_manager.lock() {
        Ok(manager) => {
            if let Err(e) = manager.update_presence(data) {
                eprintln!("[internal][discord_rpc] failed to update presence: {}", e);
                // Don't return error - Discord might not be running
            }
        }
        Err(e) => {
            eprintln!("[internal][discord_rpc] failed to lock manager: {}", e);
        }
    }
    Ok(())
}

#[tauri::command]
fn discord_rpc_clear(
    discord_manager: tauri::State<
        '_,
        std::sync::Arc<std::sync::Mutex<discord_rpc::DiscordRpcManager>>,
    >,
) -> Result<(), CommandError> {
    match discord_manager.lock() {
        Ok(manager) => {
            if let Err(e) = manager.clear_presence() {
                eprintln!("[internal][discord_rpc] failed to clear presence: {}", e);
            }
        }
        Err(e) => {
            eprintln!("[internal][discord_rpc] failed to lock manager: {}", e);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize Discord RPC manager
    let discord_manager =
        std::sync::Arc::new(std::sync::Mutex::new(discord_rpc::DiscordRpcManager::new()));

    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(CacheLock(Mutex::new(())))
        .manage(AppSettingsLock(Mutex::new(())))
        .manage(discord_manager)
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(debug_assertions))]
    {
        let port = pick_unused_port().expect("failed to find an unused localhost port");
        let url: url::Url = format!("http://localhost:{}", port)
            .parse()
            .expect("failed to parse localhost url");
        let _window_url = WindowUrl::External(url.clone());

        context.config_mut().build.frontend_dist = Some(FrontendDist::Url(url));
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());
    }

    #[cfg(target_os = "windows")]
    let builder = builder.manage(windows_media::WindowsMediaSession::new());

    builder
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                eprintln!(
                    "[internal][tauri][info] window close requested label={}",
                    window.label()
                );
                if window.label() == "main" {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            }
            tauri::WindowEvent::Focused(false) => {
                if window.label() == "main" {
                    let app = window.app_handle().clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(100));

                        if let Some(main) = app.get_webview_window("main") {
                            if let Ok(true) = main.is_focused() {
                                return;
                            }
                        }

                        if let Some(mini) = app.get_webview_window("mini-player") {
                            if let Ok(true) = mini.is_focused() {
                                return;
                            }
                        }

                        let _ = app.emit("main-window-backgrounded", ());
                    });
                }
            }
            tauri::WindowEvent::Focused(true) => {
                if window.label() == "main" {
                    let _ = window.app_handle().emit("window-focused", ());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            quit_app,
            frontend_log,
            app_setting_get,
            app_setting_set,
            app_setting_remove,
            fetch_audio_bytes,
            fetch_youtube_music_audio,
            proxy_http_request,
            save_youtube_credentials,
            load_youtube_credentials,
            delete_youtube_credentials,
            load_youtube_music_cookie,
            sign_in_youtube_music,
            delete_youtube_music_cookie,
            cache_get,
            cache_set,
            cache_stats,
            cache_set_max_bytes,
            cache_clear,
            discord_rpc_update,
            discord_rpc_clear,
            #[cfg(target_os = "windows")]
            windows_media::update_windows_media_session
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::cookie_domain_matches;

    #[test]
    fn cookie_domain_matches_exact_and_parent_domains() {
        assert!(cookie_domain_matches(
            "music.youtube.com",
            Some("music.youtube.com")
        ));
        assert!(cookie_domain_matches(
            "music.youtube.com",
            Some(".youtube.com")
        ));
        assert!(cookie_domain_matches(
            "music.youtube.com",
            Some("youtube.com")
        ));
    }

    #[test]
    fn cookie_domain_rejects_unrelated_and_partial_domains() {
        assert!(!cookie_domain_matches(
            "music.youtube.com",
            Some("accounts.google.com")
        ));
        assert!(!cookie_domain_matches(
            "music.youtube.com",
            Some("notyoutube.com")
        ));
        assert!(!cookie_domain_matches("music.youtube.com", None));
    }
}
