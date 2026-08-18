// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(not(debug_assertions))]
use portpicker::pick_unused_port;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        let message = $crate::sanitize_log_message(&format!($($arg)*));
        std::eprintln!("{}", message);
        $crate::append_log_line(format_args!("{}", message));
    }};
}

#[cfg(not(debug_assertions))]
use tauri::utils::config::FrontendDist;
#[cfg(not(debug_assertions))]
use tauri::utils::config_v1::WindowUrl;

use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

#[cfg(target_os = "macos")]
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
#[cfg(target_os = "macos")]
use rand::{rngs::OsRng, RngCore};

#[cfg(target_os = "macos")]
mod macos_media;
#[cfg(target_os = "windows")]
mod windows_media;

mod discord_rpc;
mod lastfm;

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
const YOUTUBE_COOKIE_PERSIST_INTERVAL: Duration = Duration::from_secs(300);
const YOUTUBE_SLOW_PERSIST_COOKIES: [&str; 3] = ["SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC"];
const DEFAULT_CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CURRENT_LOG_FILE_NAME: &str = "current.log";
const CUSTOM_THEME_CSS_FILE_NAME: &str = "custom-theme.css";
const CUSTOM_THEME_CSS_MAX_BYTES: u64 = 100 * 1024;
const MINIMIZE_TO_TRAY_KEY: &str = "minimize-to-system-tray-enabled";
const APP_TRAY_ID: &str = "main-tray";
const TRAY_MENU_SHOW_ID: &str = "show-main-window";
const TRAY_MENU_QUIT_ID: &str = "quit-app";

static APP_LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();
static DOWNLOAD_CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

struct CacheLock(Mutex<()>);
struct AppSettingsLock(Mutex<()>);

#[derive(Default)]
struct CookieJarState {
    cookie: Option<String>,
    persisted_at: Option<Instant>,
}

struct YoutubeCookieJar(Mutex<CookieJarState>);

fn parse_cookie_header(header: &str) -> Vec<(String, String)> {
    header
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn serialize_cookie_pairs(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn split_set_cookie(set_cookie: &str) -> Option<(&str, &str)> {
    let (name, value) = set_cookie.split(';').next()?.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some((name, value.trim()))
}

fn apply_set_cookie(pairs: &mut Vec<(String, String)>, set_cookie: &str) -> bool {
    let Some((name, value)) = split_set_cookie(set_cookie) else {
        return false;
    };
    let name = name.to_string();
    let value = value.to_string();

    if value.is_empty() || value == "EXPIRED" || value == "deleted" {
        let before = pairs.len();
        pairs.retain(|(existing, _)| existing != &name);
        return pairs.len() != before;
    }

    match pairs.iter_mut().find(|(existing, _)| existing == &name) {
        Some(entry) if entry.1 == value => false,
        Some(entry) => {
            entry.1 = value;
            true
        }
        None => {
            pairs.push((name, value));
            true
        }
    }
}

fn is_youtube_cookie_host(url: &url::Url) -> bool {
    url.host_str()
        .is_some_and(|host| host == "youtube.com" || host.ends_with(".youtube.com"))
}

fn is_slow_persist_cookie(set_cookie: &str) -> bool {
    split_set_cookie(set_cookie)
        .is_some_and(|(name, _)| YOUTUBE_SLOW_PERSIST_COOKIES.contains(&name))
}

fn refresh_youtube_cookie_jar(
    app: &tauri::AppHandle,
    jar: &YoutubeCookieJar,
    set_cookies: &[String],
) -> Option<String> {
    let (merged, should_persist) = {
        let mut state = jar.0.lock().ok()?;
        let mut pairs = parse_cookie_header(state.cookie.as_deref()?);
        let mut changed = false;
        let mut credential_changed = false;
        for set_cookie in set_cookies {
            if apply_set_cookie(&mut pairs, set_cookie) {
                changed = true;
                credential_changed |= !is_slow_persist_cookie(set_cookie);
            }
        }
        if !changed {
            return None;
        }

        let merged = serialize_cookie_pairs(&pairs);
        state.cookie = Some(merged.clone());
        let should_persist = credential_changed
            || state
                .persisted_at
                .map_or(true, |at| at.elapsed() >= YOUTUBE_COOKIE_PERSIST_INTERVAL);
        if should_persist {
            state.persisted_at = Some(Instant::now());
        }
        (merged, should_persist)
    };

    if should_persist {
        match save_youtube_music_cookie(app, &merged) {
            Ok(()) => eprintln!(
                "[internal][tauri][info] youtube cookie rotated and persisted bytes={}",
                merged.len()
            ),
            Err(error) => eprintln!(
                "[internal][tauri][warn] youtube cookie persist failed: {}",
                error.message
            ),
        }
    }
    Some(merged)
}

fn header_key(headers: &HashMap<String, String>, name: &str) -> Option<String> {
    headers
        .keys()
        .find(|key| key.eq_ignore_ascii_case(name))
        .cloned()
}

fn header_value<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn set_header(headers: &mut HashMap<String, String>, name: &str, value: String) {
    if let Some(key) = header_key(headers, name) {
        headers.insert(key, value);
    } else {
        headers.insert(name.to_string(), value);
    }
}

fn get_cookie_value(cookie_header: &str, name: &str) -> Option<String> {
    parse_cookie_header(cookie_header)
        .into_iter()
        .find(|(cookie_name, _)| cookie_name == name)
        .map(|(_, value)| value)
}

fn get_sapisid_auth_cookie(cookie_header: &str) -> Option<String> {
    get_cookie_value(cookie_header, "SAPISID")
        .or_else(|| get_cookie_value(cookie_header, "__Secure-1PAPISID"))
        .or_else(|| get_cookie_value(cookie_header, "__Secure-3PAPISID"))
}

fn sha1_hex(input: &[u8]) -> String {
    let mut data = input.to_vec();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    let mut h0 = 0x67452301_u32;
    let mut h1 = 0xefcdab89_u32;
    let mut h2 = 0x98badcfe_u32;
    let mut h3 = 0x10325476_u32;
    let mut h4 = 0xc3d2e1f0_u32;

    for chunk in data.chunks_exact(64) {
        let mut words = [0_u32; 80];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let start = index * 4;
            *word = u32::from_be_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for (index, word) in words.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    format!("{h0:08x}{h1:08x}{h2:08x}{h3:08x}{h4:08x}")
}

fn youtube_auth_origin(headers: &HashMap<String, String>) -> &'static str {
    if header_value(headers, "x-youtube-client-name") == Some("67") {
        "https://music.youtube.com"
    } else {
        "https://www.youtube.com"
    }
}

fn youtube_request_needs_cookie_auth(request_url: &url::Url) -> bool {
    request_url.path().starts_with("/youtubei/") || request_url.path().starts_with("/api/stats/")
}

fn sync_youtube_cookie_auth(
    headers: &mut HashMap<String, String>,
    request_url: &url::Url,
    cookie: &str,
) {
    let Some(cookie_key) = header_key(headers, "cookie") else {
        return;
    };
    headers.insert(cookie_key, cookie.to_string());

    if !youtube_request_needs_cookie_auth(request_url) {
        return;
    }

    let Some(sapisid) = get_sapisid_auth_cookie(cookie) else {
        return;
    };
    let origin = youtube_auth_origin(headers);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let hash = sha1_hex(format!("{timestamp} {sapisid} {origin}").as_bytes());
    set_header(
        headers,
        "authorization",
        format!("SAPISIDHASH {timestamp}_{hash}"),
    );
    set_header(headers, "x-goog-request-time", timestamp.to_string());
    set_header(headers, "origin", origin.to_string());
    set_header(headers, "x-origin", origin.to_string());
    set_header(headers, "referer", format!("{origin}/"));
}

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAudioFile {
    path: String,
    title: String,
    album: Option<String>,
    duration_sec: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadAudioSaveResult {
    file_path: String,
    byte_length: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadDiscoveredFile {
    track_id: String,
    file_path: String,
    mime_type: String,
    byte_length: u64,
    modified_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    track_id: String,
    percent: u8,
}

fn cache_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

fn signed_googlevideo_local_address(url: &url::Url) -> Option<IpAddr> {
    if !url
        .host_str()
        .is_some_and(|host| host.ends_with(".googlevideo.com"))
    {
        return None;
    }

    let signed_ip = url.query_pairs().find_map(|(key, value)| {
        (key == "ip")
            .then(|| value.parse::<IpAddr>().ok())
            .flatten()
    })?;

    Some(match signed_ip {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    })
}

fn local_audio_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn is_local_audio_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "mp3" | "m4a" | "mp4" | "aac" | "flac" | "wav" | "ogg" | "oga" | "opus" | "webm"
    )
}

fn local_audio_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

fn scan_local_audio_path(path: &Path, files: &mut Vec<LocalAudioFile>) -> Result<(), CommandError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(()),
    };

    if metadata.is_file() {
        if is_local_audio_file(path) {
            files.push(LocalAudioFile {
                path: path.to_string_lossy().to_string(),
                title: local_audio_title(path),
                album: path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    .map(|name| name.to_string()),
                duration_sec: None,
            });
        }
        return Ok(());
    }

    if !metadata.is_dir() {
        return Ok(());
    }

    let entries = fs::read_dir(path).map_err(|error| CommandError {
        message: format!("local audio directory read failed: {error}"),
    })?;

    for entry in entries.flatten() {
        scan_local_audio_path(&entry.path(), files)?;
    }

    Ok(())
}

#[tauri::command]
fn local_audio_scan(paths: Vec<String>) -> Result<Vec<LocalAudioFile>, CommandError> {
    let mut files = Vec::new();
    for path in paths {
        let trimmed_path = path.trim();
        if trimmed_path.is_empty() {
            continue;
        }
        scan_local_audio_path(Path::new(trimmed_path), &mut files)?;
    }
    files.sort_by(|left, right| left.path.to_lowercase().cmp(&right.path.to_lowercase()));
    files.dedup_by(|left, right| left.path == right.path);
    Ok(files)
}

#[tauri::command]
fn local_audio_read(path: String) -> Result<AudioPayload, CommandError> {
    let path = PathBuf::from(path);
    if !path.is_file() || !is_local_audio_file(&path) {
        return Err(CommandError {
            message: "local audio file is unavailable.".to_string(),
        });
    }
    let bytes = fs::read(&path).map_err(|error| CommandError {
        message: format!("local audio read failed: {error}"),
    })?;
    Ok(AudioPayload {
        body_base64: STANDARD.encode(bytes),
        mime_type: local_audio_mime_type(&path).to_string(),
    })
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

fn custom_theme_css_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(CUSTOM_THEME_CSS_FILE_NAME))
        .map_err(|error| CommandError {
            message: format!("application data directory unavailable: {error}"),
        })
}

fn validate_custom_theme_css_path(path: &Path) -> Result<(), CommandError> {
    if !path.is_file() {
        return Err(CommandError {
            message: "Choose a CSS file that exists.".to_string(),
        });
    }

    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("css"))
    {
        return Err(CommandError {
            message: "Custom themes must use a .css file.".to_string(),
        });
    }

    let metadata = fs::metadata(path).map_err(|error| CommandError {
        message: format!("custom theme metadata read failed: {error}"),
    })?;

    if metadata.len() > CUSTOM_THEME_CSS_MAX_BYTES {
        return Err(CommandError {
            message: "Custom theme CSS must be 100 KB or smaller.".to_string(),
        });
    }

    Ok(())
}

fn validate_custom_theme_css(css: &str) -> Result<(), CommandError> {
    let normalized = css.to_ascii_lowercase();
    if normalized.contains("@import") {
        return Err(CommandError {
            message: "Custom theme CSS cannot use @import.".to_string(),
        });
    }

    if normalized.contains("javascript:") {
        return Err(CommandError {
            message: "Custom theme CSS cannot use javascript: URLs.".to_string(),
        });
    }

    Ok(())
}

fn sanitize_theme_username(username: &str) -> String {
    let sanitized = username
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
        .collect::<String>();

    if sanitized.is_empty() {
        "user".to_string()
    } else {
        sanitized
    }
}

fn read_system_username() -> String {
    ["USERNAME", "USER", "LOGNAME"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.trim().is_empty())
        .or_else(|| {
            ["USERPROFILE", "HOME"]
                .iter()
                .filter_map(|key| std::env::var_os(key))
                .filter_map(|path| {
                    PathBuf::from(path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_string)
                })
                .find(|value| !value.trim().is_empty())
        })
        .map(|value| sanitize_theme_username(&value))
        .unwrap_or_else(|| "user".to_string())
}

#[tauri::command]
fn system_username_get() -> String {
    read_system_username()
}

#[tauri::command]
fn custom_theme_css_import(app: tauri::AppHandle, path: String) -> Result<(), CommandError> {
    let source_path = PathBuf::from(path);
    validate_custom_theme_css_path(&source_path)?;

    let css = fs::read_to_string(&source_path).map_err(|error| CommandError {
        message: format!("custom theme CSS read failed: {error}"),
    })?;
    validate_custom_theme_css(&css)?;

    let target_path = custom_theme_css_path(&app)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| CommandError {
            message: format!("custom theme directory creation failed: {error}"),
        })?;
    }

    fs::write(target_path, css).map_err(|error| CommandError {
        message: format!("custom theme CSS write failed: {error}"),
    })
}

#[tauri::command]
fn custom_theme_css_get(app: tauri::AppHandle) -> Result<Option<String>, CommandError> {
    let path = custom_theme_css_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let metadata = fs::metadata(&path).map_err(|error| CommandError {
        message: format!("custom theme metadata read failed: {error}"),
    })?;

    if metadata.len() > CUSTOM_THEME_CSS_MAX_BYTES {
        return Err(CommandError {
            message: "Custom theme CSS must be 100 KB or smaller.".to_string(),
        });
    }

    let css = fs::read_to_string(path).map_err(|error| CommandError {
        message: format!("custom theme CSS read failed: {error}"),
    })?;
    validate_custom_theme_css(&css)?;
    Ok(Some(css))
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
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(HashMap::new());
    }
    serde_json::from_slice(&bytes).map_err(|error| CommandError {
        message: format!("application settings parse failed: {error}"),
    })
}

fn read_bool_app_setting(app: &tauri::AppHandle, key: &str, default_value: bool) -> bool {
    read_app_settings(app)
        .ok()
        .and_then(|settings| settings.get(key).and_then(|value| value.as_bool()))
        .unwrap_or(default_value)
}

fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }

    if let Some(tray) = app.tray_by_id(APP_TRAY_ID) {
        let _ = tray.set_visible(false);
    }
}

fn hide_main_window_to_tray(app: &tauri::AppHandle, window: &tauri::Window) {
    if let Some(tray) = app.tray_by_id(APP_TRAY_ID) {
        let _ = tray.set_visible(true);
    }
    let _ = window.hide();
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

fn current_log_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_log_dir()
        .map(|path| path.join(CURRENT_LOG_FILE_NAME))
        .map_err(|error| CommandError {
            message: format!("log directory unavailable: {error}"),
        })
}

fn initialize_app_log(app: &tauri::AppHandle) -> Result<(), CommandError> {
    let log_path = current_log_path(app)?;
    let log_dir = log_path.parent().ok_or_else(|| CommandError {
        message: "log directory unavailable".to_string(),
    })?;

    fs::create_dir_all(log_dir).map_err(|error| CommandError {
        message: format!("log directory creation failed: {error}"),
    })?;

    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != log_path
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("log"))
            {
                let _ = fs::remove_file(path);
            }
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|error| CommandError {
            message: format!("log file creation failed: {error}"),
        })?;

    let log_file = APP_LOG_FILE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = log_file.lock() {
        *guard = Some(file);
    }

    append_log_line(format_args!(
        "[internal][tauri][info] log initialized path={}",
        log_path.display()
    ));
    Ok(())
}

pub(crate) fn append_log_line(args: fmt::Arguments<'_>) {
    let Some(log_file) = APP_LOG_FILE.get() else {
        return;
    };
    let Ok(mut guard) = log_file.lock() else {
        return;
    };
    let Some(file) = guard.as_mut() else {
        return;
    };
    let _ = writeln!(file, "{args}");
}

pub(crate) fn sanitize_log_message(message: &str) -> String {
    message
        .split_whitespace()
        .map(sanitize_log_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn sanitize_log_token(token: &str) -> String {
    if let Some((key, value)) = token.split_once('=') {
        let normalized_key = key
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .to_ascii_lowercase();
        if normalized_key.contains("cookie")
            || normalized_key.contains("authorization")
            || normalized_key.contains("credential")
            || normalized_key.contains("token")
            || normalized_key.contains("secret")
            || normalized_key.contains("password")
            || normalized_key.contains("signature")
            || normalized_key.contains("cipher")
            || normalized_key.contains("visitor")
        {
            return format!("{key}=[redacted]");
        }
        if value.starts_with("http://") || value.starts_with("https://") {
            return format!("{key}={}", sanitize_log_url(value));
        }
    }

    if token.starts_with("http://") || token.starts_with("https://") {
        return sanitize_log_url(token);
    }

    token.to_string()
}

fn sanitize_log_url(value: &str) -> String {
    match url::Url::parse(value) {
        Ok(mut parsed) => {
            parsed.set_query(None);
            parsed.set_fragment(None);
            format!(
                "{}{}",
                parsed.as_str().trim_end_matches('/'),
                if value.contains('?') {
                    "?[redacted]"
                } else {
                    ""
                }
            )
        }
        Err(_) => "[redacted-url]".to_string(),
    }
}

#[tauri::command]
fn open_current_log(app: tauri::AppHandle) -> Result<(), CommandError> {
    let log_path = current_log_path(&app)?;
    if !log_path.exists() {
        initialize_app_log(&app)?;
    }
    tauri_plugin_opener::open_path(&log_path, None::<&str>).map_err(|error| CommandError {
        message: format!("unable to open log file: {error}"),
    })
}

#[tauri::command]
fn app_settings_clear(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
) -> Result<(), CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    let path = app_settings_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| CommandError {
            message: format!("application settings clear failed: {error}"),
        })?;
    }
    Ok(())
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
fn load_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<Option<String>, CommandError> {
    #[cfg(target_os = "macos")]
    let cookie = {
        if let Some(cookie) = load_encrypted_youtube_music_cookie(&app)? {
            Some(cookie)
        } else if let Some(cookie) = load_youtube_music_cookie_entries()? {
            save_youtube_music_cookie(&app, &cookie)?;
            delete_youtube_music_cookie_entries()?;
            Some(cookie)
        } else {
            None
        }
    };

    #[cfg(not(target_os = "macos"))]
    let cookie = {
        let _ = app;
        load_youtube_music_cookie_entries()
    }?;

    if let Ok(mut state) = jar.0.lock() {
        state.cookie = cookie.clone();
        state.persisted_at = None;
    }
    Ok(cookie)
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
async fn sign_in_youtube_music(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<String, CommandError> {
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

    let sign_in_cancelled = Arc::new(AtomicBool::new(false));
    let sign_in_cancelled_for_event = Arc::clone(&sign_in_cancelled);
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            sign_in_cancelled_for_event.store(true, Ordering::SeqCst);
        }
    });

    #[cfg(not(target_os = "macos"))]
    let cookie_url: url::Url =
        "https://music.youtube.com/"
            .parse()
            .map_err(|error| CommandError {
                message: format!("invalid YouTube Music cookie URL: {error}"),
            })?;

    for poll in 1..=300 {
        if sign_in_cancelled.load(Ordering::SeqCst)
            || app.get_webview_window(YOUTUBE_LOGIN_WINDOW).is_none()
        {
            eprintln!(
                "[internal][tauri][warn] sign_in_youtube_music cancelled poll={}",
                poll
            );
            return Err(CommandError {
                message: "YouTube Music sign-in was cancelled.".to_string(),
            });
        }

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
            if let Ok(mut state) = jar.0.lock() {
                state.cookie = Some(cookie_header.clone());
                state.persisted_at = Some(Instant::now());
            }
            eprintln!("[internal][tauri][info] sign_in_youtube_music credential saved");
            let _ = window.close();
            eprintln!("[internal][tauri][info] sign_in_youtube_music login window close requested");
            return Ok(cookie_header);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let _ = window.close();
    eprintln!("[internal][tauri][warn] sign_in_youtube_music timed out");
    Err(CommandError {
        message: "YouTube Music sign-in timed out.".to_string(),
    })
}

#[tauri::command]
async fn delete_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<(), CommandError> {
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
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = None;
        state.persisted_at = None;
    }
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
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
struct ProxyHttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cookie: Option<String>,
}

#[derive(Clone)]
struct MediaItem {
    bytes: Arc<Vec<u8>>,
    mime_type: String,
    last_used_seq: u64,
}

const MEDIA_SERVER_MAX_ITEMS: usize = 24;

// Monotonic sequence instead of wall-clock time: a SystemTime step
// backwards must never make a fresh item look like the oldest one.
fn media_lru_sequence() -> u64 {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

fn evict_overflowing_media_items(items: &mut HashMap<String, MediaItem>) {
    while items.len() > MEDIA_SERVER_MAX_ITEMS {
        let Some(oldest_key) = items
            .iter()
            .min_by_key(|(_, item)| item.last_used_seq)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        items.remove(&oldest_key);
    }
}

struct MediaServer {
    origin: String,
    items: Arc<Mutex<HashMap<String, MediaItem>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioSourcePayload {
    url: String,
    mime_type: String,
    byte_length: usize,
}

static MEDIA_SERVER: OnceLock<MediaServer> = OnceLock::new();

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

fn media_server() -> Result<&'static MediaServer, CommandError> {
    if let Some(server) = MEDIA_SERVER.get() {
        return Ok(server);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| CommandError {
        message: format!("media server bind failed: {error}"),
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| CommandError {
            message: format!("media server local address failed: {error}"),
        })?
        .port();
    let items = Arc::new(Mutex::new(HashMap::<String, MediaItem>::new()));
    let thread_items = Arc::clone(&items);
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let items = Arc::clone(&thread_items);
                    thread::spawn(move || handle_media_request(stream, items));
                }
                Err(error) => {
                    eprintln!(
                        "[internal][tauri][warn] media server accept failed error={}",
                        error
                    );
                }
            }
        }
    });

    let server = MediaServer {
        origin: format!("http://127.0.0.1:{port}"),
        items,
    };
    let _ = MEDIA_SERVER.set(server);
    MEDIA_SERVER.get().ok_or_else(|| CommandError {
        message: "media server initialization failed".into(),
    })
}

fn handle_media_request(
    mut stream: std::net::TcpStream,
    items: Arc<Mutex<HashMap<String, MediaItem>>>,
) {
    let mut buffer = [0_u8; 4096];
    let read_len = match stream.read(&mut buffer) {
        Ok(len) => len,
        Err(error) => {
            eprintln!(
                "[internal][tauri][warn] media server read failed error={}",
                error
            );
            return;
        }
    };
    let request = String::from_utf8_lossy(&buffer[..read_len]);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let path = request_parts.next().unwrap_or_default();
    if method != "GET" && method != "HEAD" {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
        return;
    }

    let range_header = lines.find_map(|line| {
        line.strip_prefix("Range:")
            .or_else(|| line.strip_prefix("range:"))
            .map(str::trim)
            .map(str::to_string)
    });
    let key = path
        .trim_start_matches("/audio/")
        .split('?')
        .next()
        .unwrap_or_default();
    let item = match items.lock().ok().and_then(|mut items| {
        let item = items.get_mut(key)?;
        item.last_used_seq = media_lru_sequence();
        Some(item.clone())
    }) {
        Some(item) => item,
        None => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            return;
        }
    };

    let total_len = item.bytes.len();
    let (status, start, end) = parse_media_range(range_header.as_deref(), total_len).unwrap_or((
        "200 OK",
        0,
        total_len.saturating_sub(1),
    ));
    let body_len = if total_len == 0 { 0 } else { end - start + 1 };
    let content_range = if status.starts_with("206") {
        format!("Content-Range: bytes {start}-{end}/{total_len}\r\n")
    } else {
        String::new()
    };
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\n{}Content-Length: {body_len}\r\nConnection: close\r\n\r\n",
        item.mime_type,
        content_range,
    );
    let _ = stream.write_all(headers.as_bytes());
    if method == "HEAD" || total_len == 0 {
        return;
    }
    let _ = stream.write_all(&item.bytes[start..=end]);
}

fn parse_media_range(
    range_header: Option<&str>,
    total_len: usize,
) -> Option<(&'static str, usize, usize)> {
    let value = range_header?.strip_prefix("bytes=")?;
    if total_len == 0 {
        return None;
    }
    let (start_raw, end_raw) = value.split_once('-')?;
    let start = if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<usize>().ok()?;
        total_len.saturating_sub(suffix_len)
    } else {
        start_raw.parse::<usize>().ok()?
    };
    let end = if end_raw.is_empty() {
        total_len - 1
    } else {
        end_raw.parse::<usize>().ok()?.min(total_len - 1)
    };
    (start <= end && start < total_len).then_some(("206 Partial Content", start, end))
}

fn build_audio_http_client(
    request_url: &url::Url,
    force_signed_ip_family: bool,
) -> Result<reqwest::Client, CommandError> {
    let mut client_builder = reqwest::Client::builder();
    if force_signed_ip_family {
        if let Some(local_address) = signed_googlevideo_local_address(request_url) {
            eprintln!(
                "[internal][tauri][info] fetch_audio_bytes forcing signed IP family family={}",
                if local_address.is_ipv6() {
                    "ipv6"
                } else {
                    "ipv4"
                }
            );
            client_builder = client_builder.local_address(local_address);
        }
    }
    client_builder.build().map_err(|error| CommandError {
        message: format!("audio HTTP client creation failed: {error}"),
    })
}

fn signed_content_length(request_url: &url::Url) -> Option<u64> {
    request_url
        .query_pairs()
        .find(|(key, _)| key == "clen")
        .and_then(|(_, value)| value.parse::<u64>().ok())
}

fn audio_url_with_range(url: &str, start: u64, end: u64) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}range={start}-{end}")
}

fn audio_chunk_size(total: u64) -> u64 {
    const MIN_CHUNK_BYTES: u64 = 512 * 1024;
    const MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
    const TARGET_CHUNKS: u64 = 6;
    (total / TARGET_CHUNKS)
        .max(MIN_CHUNK_BYTES)
        .min(MAX_CHUNK_BYTES)
}

async fn send_audio_bytes_request(
    client: &reqwest::Client,
    url: &str,
    track_id: &str,
    cookie: Option<&str>,
    client_name: &str,
    profile_name: &str,
    referer_origin: Option<(&str, &str)>,
) -> Result<Vec<u8>, CommandError> {
    let mut request = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept-Encoding", "identity;q=1, *;q=0");

    if let Some((referer, origin)) = referer_origin {
        request = request
            .header("Origin", origin)
            .header("Referer", referer)
            .header("Sec-Fetch-Dest", "audio")
            .header("Sec-Fetch-Mode", "no-cors")
            .header("Sec-Fetch-Site", "cross-site");
    }

    if let Some(cookie) = cookie.filter(|value| !value.trim().is_empty()) {
        request = request.header("Cookie", cookie);
    }

    let response = request.send().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] fetch_audio_bytes request failed url={} track_id={} client={} profile={} error={}",
            url, track_id, client_name, profile_name, error
        );
        CommandError {
            message: format!("request failed: {error}"),
        }
    })?;

    if !response.status().is_success() {
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| format!("{name}={}", value.to_str().unwrap_or("?")))
            .collect::<Vec<_>>()
            .join(", ");
        let status = response.status();
        eprintln!(
            "[internal][tauri][warn] fetch_audio_bytes non-success url={} track_id={} client={} profile={} status={} headers=[{}]",
            url, track_id, client_name, profile_name, status, headers
        );
        return Err(CommandError {
            message: format!("request returned {status}"),
        });
    }

    let body = response.bytes().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] fetch_audio_bytes body read failed url={} track_id={} client={} profile={} error={}",
            url, track_id, client_name, profile_name, error
        );
        CommandError {
            message: format!("read body failed: {error}"),
        }
    })?;

    Ok(body.to_vec())
}

async fn fetch_audio_bytes_inner(
    url: &str,
    track_id: &str,
    cookie: Option<&str>,
    cancel_flag: Option<&AtomicBool>,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<Vec<u8>, CommandError> {
    let started_at = Instant::now();
    eprintln!(
        "[internal][tauri][info] fetch_audio_bytes start url={} track_id={}",
        url, track_id
    );
    let request_url = url::Url::parse(url).map_err(|error| CommandError {
        message: format!("audio URL parse failed: {error}"),
    })?;
    let watch_referer = format!("https://www.youtube.com/watch?v={track_id}");
    let music_profile = Some(("https://music.youtube.com/", "https://music.youtube.com"));
    let request_profiles: Vec<(&str, Option<(&str, &str)>)> = vec![
        ("music", music_profile),
        (
            "youtube",
            Some((watch_referer.as_str(), "https://www.youtube.com")),
        ),
        ("bare", None),
    ];
    let client_profiles = if signed_googlevideo_local_address(&request_url).is_some() {
        vec![("signed-ip-family", true), ("default-ip-family", false)]
    } else {
        vec![("default-ip-family", false)]
    };
    let total_bytes = signed_content_length(&request_url).unwrap_or(0);
    let chunk_size = audio_chunk_size(total_bytes);
    let use_range_query = total_bytes > chunk_size;
    let mut failures = Vec::new();

    for (client_name, force_signed_ip_family) in client_profiles {
        let client = build_audio_http_client(&request_url, force_signed_ip_family)?;
        for (profile_name, referer_origin) in &request_profiles {
            if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Err(cache_error("download cancelled"));
            }

            if use_range_query {
                let mut bytes = Vec::with_capacity(total_bytes as usize);
                let mut start = 0u64;
                let mut failed = None;
                while start < total_bytes {
                    if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                        return Err(cache_error("download cancelled"));
                    }
                    let end = (start + chunk_size - 1).min(total_bytes - 1);
                    match send_audio_bytes_request(
                        &client,
                        &audio_url_with_range(url, start, end),
                        track_id,
                        cookie,
                        client_name,
                        profile_name,
                        *referer_origin,
                    )
                    .await
                    {
                        Ok(chunk) => {
                            bytes.extend_from_slice(&chunk);
                            on_progress(bytes.len() as u64, total_bytes);
                            start = end + 1;
                        }
                        Err(error) => {
                            failed = Some(error);
                            break;
                        }
                    }
                }

                if let Some(error) = failed {
                    failures.push(format!("{client_name}/{profile_name}: {}", error.message));
                    continue;
                }

                if bytes.len() as u64 != total_bytes {
                    failures.push(format!(
                        "{client_name}/{profile_name}: incomplete download {} of {} bytes",
                        bytes.len(),
                        total_bytes
                    ));
                    continue;
                }

                eprintln!(
                    "[internal][tauri][info] fetch_audio_bytes success url={} client={} profile={} bytes={} ranged=true duration_ms={}",
                    url,
                    client_name,
                    profile_name,
                    bytes.len(),
                    started_at.elapsed().as_millis()
                );
                return Ok(bytes);
            }

            let bytes = match send_audio_bytes_request(
                &client,
                url,
                track_id,
                cookie,
                client_name,
                profile_name,
                *referer_origin,
            )
            .await
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    failures.push(format!("{client_name}/{profile_name}: {}", error.message));
                    continue;
                }
            };
            let received = bytes.len() as u64;
            on_progress(
                received,
                if total_bytes > 0 {
                    total_bytes
                } else {
                    received
                },
            );

            eprintln!(
                "[internal][tauri][info] fetch_audio_bytes success url={} client={} profile={} bytes={} ranged=false duration_ms={}",
                url,
                client_name,
                profile_name,
                bytes.len(),
                started_at.elapsed().as_millis()
            );

            return Ok(bytes);
        }
    }

    Err(CommandError {
        message: format!("request failed: {}", failures.join("; ")),
    })
}

#[tauri::command]
async fn fetch_audio_bytes(
    url: String,
    track_id: String,
    cookie: Option<String>,
) -> Result<Vec<u8>, CommandError> {
    fetch_audio_bytes_inner(&url, &track_id, cookie.as_deref(), None, |_, _| {}).await
}

#[tauri::command]
async fn fetch_audio_source(
    url: String,
    track_id: String,
    mime_type: String,
    cookie: Option<String>,
) -> Result<AudioSourcePayload, CommandError> {
    let bytes =
        fetch_audio_bytes_inner(&url, &track_id, cookie.as_deref(), None, |_, _| {}).await?;
    if mime_type.contains("mp4") && bytes.len() >= 12 && &bytes[4..8] != b"ftyp" {
        let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(120)]).replace('\n', " ");
        return Err(CommandError {
            message: format!(
                "Audio download was not an MP4 file. Response started with: {preview}"
            ),
        });
    }

    let server = media_server()?;
    let key = format!(
        "{}-{}",
        track_id,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    );
    let byte_length = bytes.len();
    {
        let mut items = server.items.lock().map_err(|_| CommandError {
            message: "media server cache lock poisoned".into(),
        })?;
        items.insert(
            key.clone(),
            MediaItem {
                bytes: Arc::new(bytes),
                mime_type: mime_type.clone(),
                last_used_seq: media_lru_sequence(),
            },
        );
        evict_overflowing_media_items(&mut items);
    }

    Ok(AudioSourcePayload {
        url: format!("{}/audio/{}", server.origin, key),
        mime_type,
        byte_length,
    })
}

fn download_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    DOWNLOAD_CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn download_extension_for_mime(mime_type: &str) -> &'static str {
    let normalized = mime_type.to_ascii_lowercase();
    if normalized.contains("webm") {
        "webm"
    } else if normalized.contains("mp4") || normalized.contains("m4a") {
        "m4a"
    } else if normalized.contains("mpeg") || normalized.contains("mp3") {
        "mp3"
    } else if normalized.contains("ogg") || normalized.contains("opus") {
        "ogg"
    } else {
        "audio"
    }
}

fn download_mime_for_path(path: &Path) -> String {
    local_audio_mime_type(path).to_string()
}

fn sanitize_download_filename_part(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'
        ) {
            result.push('_');
        } else if character.is_control() {
            result.push(' ');
        } else {
            result.push(character);
        }
    }
    let trimmed = result
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(['.', ' '])
        .to_string();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.chars().take(96).collect()
    }
}

fn validate_download_track_id(track_id: &str) -> Result<(), CommandError> {
    let invalid = track_id.is_empty()
        || track_id.contains("..")
        || track_id
            .chars()
            .any(|value| value == '/' || value == '\\' || value == ':' || value == '\0');
    if invalid {
        return Err(cache_error("invalid download track id"));
    }
    Ok(())
}

fn default_music_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(profile).join("Music");
        }
    }

    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join("Music");
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[tauri::command]
fn download_default_folder() -> Result<String, CommandError> {
    Ok(default_music_dir()
        .join("Just Another Music Client")
        .join("Downloads")
        .to_string_lossy()
        .to_string())
}

fn download_file_path(
    folder: &str,
    track_id: &str,
    artist: &str,
    title: &str,
    mime_type: &str,
) -> Result<PathBuf, CommandError> {
    validate_download_track_id(track_id)?;
    let folder = PathBuf::from(folder);
    let extension = download_extension_for_mime(mime_type);
    let artist = sanitize_download_filename_part(artist);
    let title = sanitize_download_filename_part(title);
    Ok(folder.join(format!("{track_id} - {artist} - {title}.{extension}")))
}

#[tauri::command]
async fn download_audio_save(
    app: tauri::AppHandle,
    url: String,
    track_id: String,
    title: String,
    artist: String,
    folder: String,
    mime_type: String,
    cookie: Option<String>,
) -> Result<DownloadAudioSaveResult, CommandError> {
    validate_download_track_id(&track_id)?;
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = download_cancel_flags().lock().map_err(|_| CommandError {
            message: "download cancel lock poisoned".into(),
        })?;
        flags.insert(track_id.clone(), cancel_flag.clone());
    }

    let target_path = download_file_path(&folder, &track_id, &artist, &title, &mime_type)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| CommandError {
            message: format!("download directory creation failed: {error}"),
        })?;
    }
    let part_path = target_path.with_extension("part");
    let _ = fs::remove_file(&part_path);

    if cancel_flag.load(Ordering::SeqCst) {
        return Err(cache_error("download cancelled"));
    }

    let mut last_percent = 0u8;
    let bytes = match fetch_audio_bytes_inner(
        &url,
        &track_id,
        cookie.as_deref(),
        Some(cancel_flag.as_ref()),
        |received, total| {
            if total == 0 {
                return;
            }
            let percent = ((received * 100) / total).min(99) as u8;
            if percent <= last_percent {
                return;
            }
            last_percent = percent;
            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    track_id: track_id.clone(),
                    percent,
                },
            );
        },
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&part_path);
            let _ = download_cancel_flags()
                .lock()
                .map(|mut flags| flags.remove(&track_id));
            return Err(error);
        }
    };

    if cancel_flag.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&part_path);
        let _ = download_cancel_flags()
            .lock()
            .map(|mut flags| flags.remove(&track_id));
        return Err(cache_error("download cancelled"));
    }

    fs::write(&part_path, &bytes).map_err(|error| CommandError {
        message: format!("download write failed: {error}"),
    })?;
    if target_path.exists() {
        fs::remove_file(&target_path).map_err(|error| CommandError {
            message: format!("download replace failed: {error}"),
        })?;
    }
    fs::rename(&part_path, &target_path).map_err(|error| CommandError {
        message: format!("download finalize failed: {error}"),
    })?;

    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            track_id: track_id.clone(),
            percent: 100,
        },
    );
    let _ = download_cancel_flags()
        .lock()
        .map(|mut flags| flags.remove(&track_id));

    Ok(DownloadAudioSaveResult {
        file_path: target_path.to_string_lossy().to_string(),
        byte_length: bytes.len() as u64,
    })
}

#[tauri::command]
fn download_audio_cancel(track_id: String) -> Result<(), CommandError> {
    validate_download_track_id(&track_id)?;
    if let Some(flag) = download_cancel_flags()
        .lock()
        .map_err(|_| CommandError {
            message: "download cancel lock poisoned".into(),
        })?
        .get(&track_id)
    {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
fn download_audio_file_exists(file_path: String) -> Result<bool, CommandError> {
    Ok(PathBuf::from(file_path).is_file())
}

#[tauri::command]
fn download_audio_source(
    file_path: String,
    track_id: String,
    mime_type: String,
) -> Result<AudioSourcePayload, CommandError> {
    validate_download_track_id(&track_id)?;
    let path = PathBuf::from(file_path);
    if !path.is_file() {
        return Err(cache_error("downloaded audio file is unavailable"));
    }
    let bytes = fs::read(&path).map_err(|error| CommandError {
        message: format!("downloaded audio read failed: {error}"),
    })?;
    let byte_length = bytes.len();
    let server = media_server()?;
    let key = format!("download-{track_id}-{}", now_ms());
    {
        let mut items = server.items.lock().map_err(|_| CommandError {
            message: "media server cache lock poisoned".into(),
        })?;
        items.insert(
            key.clone(),
            MediaItem {
                bytes: Arc::new(bytes),
                mime_type: mime_type.clone(),
                last_used_seq: media_lru_sequence(),
            },
        );
        evict_overflowing_media_items(&mut items);
    }
    Ok(AudioSourcePayload {
        url: format!("{}/audio/{}", server.origin, key),
        mime_type,
        byte_length,
    })
}

fn parse_download_track_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let (track_id, _) = stem.split_once(" - ")?;
    if validate_download_track_id(track_id).is_ok() {
        Some(track_id.to_string())
    } else {
        None
    }
}

#[tauri::command]
fn download_audio_list(folder: String) -> Result<Vec<DownloadDiscoveredFile>, CommandError> {
    let folder = PathBuf::from(folder);
    if !folder.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let entries = fs::read_dir(&folder).map_err(|error| CommandError {
        message: format!("download folder read failed: {error}"),
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_local_audio_file(&path) {
            continue;
        }
        let Some(track_id) = parse_download_track_id(&path) else {
            continue;
        };
        let metadata = entry.metadata().map_err(|error| CommandError {
            message: format!("download metadata read failed: {error}"),
        })?;
        let modified_at_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default();
        files.push(DownloadDiscoveredFile {
            track_id,
            file_path: path.to_string_lossy().to_string(),
            mime_type: download_mime_for_path(&path),
            byte_length: metadata.len(),
            modified_at_ms,
        });
    }
    files.sort_by(|left, right| left.file_path.cmp(&right.file_path));
    Ok(files)
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
        "[internal][tauri][debug] YOUTUBE API REQUEST - {} url={} body_bytes={}",
        attempt_name,
        api_url,
        request_body_str.len()
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

    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - response_bytes={}",
        attempt_name,
        response_text.len()
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
        let status = playability_status
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let reason = playability_status
            .get("reason")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        eprintln!(
            "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - PLAYABILITY STATUS status={} has_reason={}",
            attempt_name, status, !reason.is_empty()
        );

        if status != "OK" {
            eprintln!(
                "[internal][tauri][warn] YOUTUBE API RESPONSE - {} - VIDEO NOT PLAYABLE: status={} has_reason={}",
                attempt_name, status, !reason.is_empty()
            );
            return Err(CommandError {
                message: format!("video not playable: {status}"),
            });
        }
    }

    // Check for video details
    if let Some(video_details) = response_json.get("videoDetails") {
        let duration_seconds = video_details
            .get("lengthSeconds")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        eprintln!(
            "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - VIDEO DETAILS has_title={} duration_seconds={}",
            attempt_name,
            video_details.get("title").is_some(),
            duration_seconds
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

    let audio_url_parsed = url::Url::parse(&audio_url).map_err(|error| CommandError {
        message: format!("audio URL parse failed: {error}"),
    })?;
    let mut audio_client_builder = reqwest::Client::builder();
    if let Some(local_address) = signed_googlevideo_local_address(&audio_url_parsed) {
        eprintln!(
            "[internal][tauri][info] fetch_youtube_music_audio forcing signed IP family attempt={} family={}",
            attempt_name,
            if local_address.is_ipv6() { "ipv6" } else { "ipv4" }
        );
        audio_client_builder = audio_client_builder.local_address(local_address);
    }
    let audio_client = audio_client_builder.build().map_err(|error| CommandError {
        message: format!("audio HTTP client creation failed: {error}"),
    })?;

    // Download the audio
    let mut audio_request = audio_client
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
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    mut input: ProxyHttpRequestInput,
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

    let youtube_host = is_youtube_cookie_host(&request_url);
    if youtube_host {
        let live_cookie = jar.0.lock().ok().and_then(|state| state.cookie.clone());
        if let Some(live_cookie) = live_cookie {
            sync_youtube_cookie_auth(&mut input.headers, &request_url, &live_cookie);
        }
    }

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

    if let Some(timeout_ms) = input.timeout_ms {
        client_builder = client_builder.timeout(Duration::from_millis(timeout_ms));
    }

    if let Some(local_address) = signed_googlevideo_local_address(&request_url) {
        eprintln!(
            "[internal][tauri][info] proxy_http_request forcing signed IP family url={} family={}",
            request_target,
            if local_address.is_ipv6() {
                "ipv6"
            } else {
                "ipv4"
            }
        );
        client_builder = client_builder.local_address(local_address);
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

    let refreshed_cookie = if youtube_host {
        let set_cookies = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect::<Vec<_>>();
        (!set_cookies.is_empty())
            .then(|| refresh_youtube_cookie_jar(&app, &jar, &set_cookies))
            .flatten()
    } else {
        None
    };

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
            eprintln!(
                "[internal][tauri][debug] proxy_http_request browse_shape top_level_keys={:?} renderer_counts={:?}",
                top_level_keys, renderer_counts
            );
        }
    }

    if status >= 400 {
        eprintln!(
            "[internal][tauri][warn] proxy_http_request error_response method={} url={} status={} bytes={}",
            input.method,
            request_target,
            status,
            body.len()
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
        cookie: refreshed_cookie,
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
    song_url: Option<String>,
    artist_url: Option<String>,
    album_url: Option<String>,
    duration: u64,
    current_time: u64,
    is_playing: bool,
) -> Result<(), CommandError> {
    let data = discord_rpc::DiscordPresenceData {
        title,
        artist,
        album,
        artwork_url,
        song_url,
        artist_url,
        album_url,
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
    #[cfg(target_os = "linux")]
    {
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.decorations = true;
            }
        }
    }
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(CacheLock(Mutex::new(())))
        .manage(AppSettingsLock(Mutex::new(())))
        .manage(YoutubeCookieJar(Mutex::new(CookieJarState::default())))
        .manage(discord_manager)
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
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
    #[cfg(target_os = "macos")]
    let builder = builder.manage(macos_media::MacosMediaSession::new());

    builder
        .setup(|app| {
            if let Err(error) = initialize_app_log(app.handle()) {
                std::eprintln!("[internal][tauri][warn] {}", error.message);
            }

            let tray_menu = MenuBuilder::new(app)
                .text(TRAY_MENU_SHOW_ID, "Show")
                .separator()
                .text(TRAY_MENU_QUIT_ID, "Quit")
                .build()?;
            let mut tray = TrayIconBuilder::with_id(APP_TRAY_ID)
                .menu(&tray_menu)
                .tooltip("Just Another Music Client")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    TRAY_MENU_SHOW_ID => restore_main_window(app),
                    TRAY_MENU_QUIT_ID => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => restore_main_window(tray.app_handle()),
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }

            let tray = tray.build(app)?;
            tray.set_visible(false)?;
            Ok(())
        })
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                eprintln!(
                    "[internal][tauri][info] window close requested label={}",
                    window.label()
                );
                if window.label() == "main" {
                    api.prevent_close();
                    let app = window.app_handle();
                    if read_bool_app_setting(app, MINIMIZE_TO_TRAY_KEY, false) {
                        hide_main_window_to_tray(app, window);
                    } else {
                        app.exit(0);
                    }
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

                        if let Some(login) = app.get_webview_window(YOUTUBE_LOGIN_WINDOW) {
                            if let Ok(true) = login.is_focused() {
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
            quit_app,
            frontend_log,
            app_setting_get,
            app_setting_set,
            app_setting_remove,
            app_settings_clear,
            system_username_get,
            custom_theme_css_import,
            custom_theme_css_get,
            open_current_log,
            fetch_audio_bytes,
            fetch_audio_source,
            download_default_folder,
            download_audio_save,
            download_audio_cancel,
            download_audio_file_exists,
            download_audio_source,
            download_audio_list,
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
            local_audio_scan,
            local_audio_read,
            lastfm::lastfm_auth_token,
            lastfm::lastfm_complete_auth,
            lastfm::lastfm_disconnect,
            lastfm::lastfm_get_session,
            lastfm::lastfm_scrobble,
            lastfm::lastfm_update_now_playing,
            discord_rpc_update,
            discord_rpc_clear,
            #[cfg(target_os = "macos")]
            macos_media::update_macos_media_session,
            #[cfg(target_os = "windows")]
            windows_media::update_windows_media_session
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        cookie_domain_matches, evict_overflowing_media_items, get_sapisid_auth_cookie, sha1_hex,
        sync_youtube_cookie_auth, MediaItem, MEDIA_SERVER_MAX_ITEMS,
    };
    use std::collections::HashMap;
    use std::sync::Arc;

    #[test]
    fn media_server_eviction_keeps_most_recent_items() {
        let mut items = HashMap::new();
        for index in 0..(MEDIA_SERVER_MAX_ITEMS + 3) {
            items.insert(
                format!("key-{index}"),
                MediaItem {
                    bytes: Arc::new(Vec::new()),
                    mime_type: "audio/mp4".to_string(),
                    last_used_seq: index as u64,
                },
            );
        }

        evict_overflowing_media_items(&mut items);

        assert_eq!(items.len(), MEDIA_SERVER_MAX_ITEMS);
        assert!(items.contains_key(&format!("key-{}", MEDIA_SERVER_MAX_ITEMS + 2)));
        assert!(!items.contains_key("key-0"));
        assert!(!items.contains_key("key-2"));
    }

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

    #[test]
    fn sha1_hex_matches_known_digest() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn sapisid_cookie_prefers_primary_and_secure_fallbacks() {
        assert_eq!(
            get_sapisid_auth_cookie("SID=one; SAPISID=primary; __Secure-1PAPISID=secure"),
            Some("primary".to_string())
        );
        assert_eq!(
            get_sapisid_auth_cookie("SID=one; __Secure-3PAPISID=secure3"),
            Some("secure3".to_string())
        );
    }

    #[test]
    fn youtube_cookie_auth_uses_injected_cookie_for_hash() {
        let mut headers = HashMap::from([
            ("Cookie".to_string(), "SAPISID=old".to_string()),
            (
                "Authorization".to_string(),
                "SAPISIDHASH stale_hash".to_string(),
            ),
            ("X-Youtube-Client-Name".to_string(), "67".to_string()),
        ]);
        let url = url::Url::parse("https://music.youtube.com/youtubei/v1/browse").unwrap();

        sync_youtube_cookie_auth(&mut headers, &url, "SAPISID=new");

        assert_eq!(headers.get("Cookie"), Some(&"SAPISID=new".to_string()));
        let authorization = headers.get("Authorization").unwrap();
        let rest = authorization.strip_prefix("SAPISIDHASH ").unwrap();
        let (timestamp, hash) = rest.split_once('_').unwrap();
        assert_eq!(
            hash,
            sha1_hex(format!("{timestamp} new https://music.youtube.com").as_bytes())
        );
    }
}
