use block2::RcBlock;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_foundation::NSString;
use objc2_web_kit::{WKUserContentController, WKUserScript, WKUserScriptInjectionTime};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime, WebviewWindow};

const MEDIA_CONTROL_EVENT: &str = "macos-media-control";
const COMMAND_SUCCESS: isize = 0;
const YOUTUBE_MEDIA_SESSION_SCRIPT: &str = r#"
(() => {
  if (window.top === window) return;
  const host = window.location.hostname.toLowerCase();
  const isYouTubeHost = host === "youtube.com"
    || host.endsWith(".youtube.com")
    || host === "youtube-nocookie.com"
    || host.endsWith(".youtube-nocookie.com");
  if (!isYouTubeHost) return;

  const patchMarker = Symbol.for("just-another-music-client.media-session-patched");
  const installHandlers = () => {
    if (!("mediaSession" in navigator)) return false;

    const mediaSession = navigator.mediaSession;
    const currentSetActionHandler = mediaSession.setActionHandler;
    if (typeof currentSetActionHandler !== "function") return false;
    if (currentSetActionHandler[patchMarker]) return true;

    const postAction = (action) => {
      window.top.postMessage({
        source: "just-another-music-client",
        action,
      }, "*");
    };
    const protectedHandlers = {
      nexttrack: () => postAction("next"),
      previoustrack: () => postAction("previous"),
    };
    const originalSetActionHandler = currentSetActionHandler.bind(mediaSession);
    const setActionHandler = (action, handler) => {
      if (action === "nexttrack") {
        return originalSetActionHandler(action, protectedHandlers.nexttrack);
      }
      if (action === "previoustrack") {
        return originalSetActionHandler(action, protectedHandlers.previoustrack);
      }
      return originalSetActionHandler(action, handler);
    };

    try {
      Object.defineProperty(setActionHandler, patchMarker, { value: true });
      Object.defineProperty(mediaSession, "setActionHandler", {
        configurable: true,
        writable: true,
        value: setActionHandler,
      });
    } catch {
      return false;
    }

    try {
      originalSetActionHandler("nexttrack", protectedHandlers.nexttrack);
    } catch {}
    try {
      originalSetActionHandler("previoustrack", protectedHandlers.previoustrack);
    } catch {}
    return true;
  };

  if (!installHandlers()) {
    const retryId = window.setInterval(() => {
      if (installHandlers()) window.clearInterval(retryId);
    }, 100);
    window.setTimeout(() => window.clearInterval(retryId), 10_000);
  }
})();
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSessionUpdate {}

pub struct MacosMediaSession(Mutex<bool>);

unsafe impl Send for MacosMediaSession {}
unsafe impl Sync for MacosMediaSession {}

#[link(name = "MediaPlayer", kind = "framework")]
extern "C" {}

pub fn install_youtube_media_session_script<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    window
        .with_webview(|webview| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            unsafe {
                let controller: &WKUserContentController = &*webview.controller().cast();
                let script = WKUserScript::alloc(mtm);
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                    script,
                    &NSString::from_str(YOUTUBE_MEDIA_SESSION_SCRIPT),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    false,
                );
                controller.addUserScript(&script);
            }
        })
        .map_err(|error| error.to_string())?;

    // Setup can run after the initial document started loading. Reload once so
    // the user script is present before the YouTube iframe is created.
    window.reload().map_err(|error| error.to_string())
}

impl MacosMediaSession {
    pub fn new() -> Self {
        clear_now_playing_info();
        Self(Mutex::new(false))
    }

    fn ensure_handlers(&self, app: &AppHandle) -> Result<(), String> {
        let mut initialized = self.0.lock().map_err(|error| error.to_string())?;
        if *initialized {
            return Ok(());
        }

        install_remote_command_handler(app, "playCommand", "play")?;
        install_remote_command_handler(app, "pauseCommand", "pause")?;
        install_remote_command_handler(app, "nextTrackCommand", "next")?;
        install_remote_command_handler(app, "previousTrackCommand", "previous")?;
        *initialized = true;
        Ok(())
    }

    fn update(&self, app: &AppHandle, _update: MediaSessionUpdate) -> Result<(), String> {
        self.ensure_handlers(app)?;
        Ok(())
    }
}

fn command_center() -> *mut AnyObject {
    let class: &AnyClass = class!(MPRemoteCommandCenter);
    unsafe { msg_send![class, sharedCommandCenter] }
}

fn now_playing_info_center() -> *mut AnyObject {
    let class: &AnyClass = class!(MPNowPlayingInfoCenter);
    unsafe { msg_send![class, defaultCenter] }
}

fn clear_now_playing_info() {
    let center = now_playing_info_center();
    if center.is_null() {
        return;
    }

    let nil_info: *mut AnyObject = std::ptr::null_mut();
    unsafe {
        let _: () = msg_send![center, setNowPlayingInfo: nil_info];
    }
}

fn install_remote_command_handler(
    app: &AppHandle,
    command_selector: &str,
    action: &'static str,
) -> Result<(), String> {
    let center = command_center();
    if center.is_null() {
        return Err("macOS remote command center unavailable".to_string());
    }

    let command: *mut AnyObject = unsafe {
        match command_selector {
            "playCommand" => msg_send![center, playCommand],
            "pauseCommand" => msg_send![center, pauseCommand],
            "nextTrackCommand" => msg_send![center, nextTrackCommand],
            "previousTrackCommand" => msg_send![center, previousTrackCommand],
            _ => {
                return Err(format!(
                    "unsupported macOS media command: {command_selector}"
                ))
            }
        }
    };

    if command.is_null() {
        return Err(format!(
            "macOS media command unavailable: {command_selector}"
        ));
    }

    let app = app.clone();
    let block = RcBlock::new(move |_event: *mut AnyObject| {
        let _ = app.emit(MEDIA_CONTROL_EVENT, action);
        COMMAND_SUCCESS
    });

    unsafe {
        let _: () = msg_send![command, setEnabled: true];
        let _: *mut AnyObject = msg_send![command, addTargetWithHandler: &*block];
    }

    std::mem::forget(block);
    Ok(())
}

#[tauri::command]
pub fn update_macos_media_session(
    app: AppHandle,
    state: tauri::State<'_, MacosMediaSession>,
    update: MediaSessionUpdate,
) -> Result<(), String> {
    state.update(&app, update)
}
