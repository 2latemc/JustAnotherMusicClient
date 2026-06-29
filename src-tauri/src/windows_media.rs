use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::HSTRING,
    Foundation::{TypedEventHandler, Uri},
    Media::Playback::{
        MediaCommandEnablingRule, MediaPlaybackCommandManager,
        MediaPlaybackCommandManagerNextReceivedEventArgs,
        MediaPlaybackCommandManagerPauseReceivedEventArgs,
        MediaPlaybackCommandManagerPlayReceivedEventArgs,
        MediaPlaybackCommandManagerPreviousReceivedEventArgs, MediaPlayer,
    },
    Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsTimelineProperties,
    },
    Storage::Streams::RandomAccessStreamReference,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RPC_E_CHANGED_MODE, WPARAM},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        UI::{
            Shell::{
                DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass,
                TaskbarList, THUMBBUTTON, THUMBBUTTONFLAGS, THUMBBUTTONMASK, THB_FLAGS, THB_ICON,
                THB_TOOLTIP,
            },
            WindowsAndMessaging::{CreateIcon, DestroyIcon, HICON, WM_COMMAND},
        },
    },
};

const MEDIA_CONTROL_EVENT: &str = "windows-media-control";
const TASKBAR_SUBCLASS_ID: usize = 0x4a_41_4d_43;
const TASKBAR_BUTTON_PREVIOUS: u32 = 0x4101;
const TASKBAR_BUTTON_PLAY_PAUSE: u32 = 0x4102;
const TASKBAR_BUTTON_NEXT: u32 = 0x4103;
const THBN_CLICKED: u16 = 0x1800;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSessionUpdate {
    title: Option<String>,
    artist: Option<String>,
    artwork_url: Option<String>,
    status: String,
    force_metadata: Option<bool>,
    duration_sec: Option<f64>,
    position_sec: Option<f64>,
}

#[derive(Clone, PartialEq)]
struct MediaMetadata {
    title: String,
    artist: String,
    artwork_url: Option<String>,
}

pub struct WindowsMediaSession(Mutex<Option<NativeMediaSession>>);

struct NativeMediaSession {
    _player: MediaPlayer,
    _command_manager: MediaPlaybackCommandManager,
    controls: SystemMediaTransportControls,
    metadata: Mutex<Option<MediaMetadata>>,
    taskbar_toolbar: Mutex<Option<ThumbnailToolbar>>,
    _play_token: i64,
    _pause_token: i64,
    _next_token: i64,
    _previous_token: i64,
    _button_pressed_token: i64,
}

impl WindowsMediaSession {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn with_session<T>(
        &self,
        app: &AppHandle,
        callback: impl FnOnce(&NativeMediaSession) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut session = self.0.lock().map_err(|error| error.to_string())?;
        if session.is_none() {
            *session = Some(NativeMediaSession::new(app.clone())?);
        }
        callback(session.as_ref().expect("media session initialized"))
    }
}

impl NativeMediaSession {
    fn new(app: AppHandle) -> Result<Self, String> {
        let player = MediaPlayer::new().map_err(|error| error.to_string())?;
        let controls = player
            .SystemMediaTransportControls()
            .map_err(|error| error.to_string())?;

        controls
            .SetIsEnabled(true)
            .and_then(|_| controls.SetIsPlayEnabled(true))
            .and_then(|_| controls.SetIsPauseEnabled(true))
            .and_then(|_| controls.SetIsNextEnabled(true))
            .and_then(|_| controls.SetIsPreviousEnabled(true))
            .map_err(|error| error.to_string())?;

        let command_manager = player.CommandManager().map_err(|error| error.to_string())?;
        command_manager
            .SetIsEnabled(true)
            .and_then(|_| {
                command_manager
                    .PlayBehavior()?
                    .SetEnablingRule(MediaCommandEnablingRule::Always)
            })
            .and_then(|_| {
                command_manager
                    .PauseBehavior()?
                    .SetEnablingRule(MediaCommandEnablingRule::Always)
            })
            .and_then(|_| {
                command_manager
                    .NextBehavior()?
                    .SetEnablingRule(MediaCommandEnablingRule::Always)
            })
            .and_then(|_| {
                command_manager
                    .PreviousBehavior()?
                    .SetEnablingRule(MediaCommandEnablingRule::Always)
            })
            .map_err(|error| error.to_string())?;

        let play_app = app.clone();
        let play_token = command_manager
            .PlayReceived(&TypedEventHandler::<
                MediaPlaybackCommandManager,
                MediaPlaybackCommandManagerPlayReceivedEventArgs,
            >::new(move |_sender, args| {
                if let Some(args) = args.as_ref() {
                    args.SetHandled(true)?;
                }
                let _ = play_app.emit(MEDIA_CONTROL_EVENT, "play");
                Ok(())
            }))
            .map_err(|error| error.to_string())?;

        let pause_app = app.clone();
        let pause_token = command_manager
            .PauseReceived(&TypedEventHandler::<
                MediaPlaybackCommandManager,
                MediaPlaybackCommandManagerPauseReceivedEventArgs,
            >::new(move |_sender, args| {
                if let Some(args) = args.as_ref() {
                    args.SetHandled(true)?;
                }
                let _ = pause_app.emit(MEDIA_CONTROL_EVENT, "pause");
                Ok(())
            }))
            .map_err(|error| error.to_string())?;

        let next_app = app.clone();
        let next_token = command_manager
            .NextReceived(&TypedEventHandler::<
                MediaPlaybackCommandManager,
                MediaPlaybackCommandManagerNextReceivedEventArgs,
            >::new(move |_sender, args| {
                if let Some(args) = args.as_ref() {
                    args.SetHandled(true)?;
                }
                let _ = next_app.emit(MEDIA_CONTROL_EVENT, "next");
                Ok(())
            }))
            .map_err(|error| error.to_string())?;

        let previous_app = app.clone();
        let previous_token = command_manager
            .PreviousReceived(&TypedEventHandler::<
                MediaPlaybackCommandManager,
                MediaPlaybackCommandManagerPreviousReceivedEventArgs,
            >::new(move |_sender, args| {
                if let Some(args) = args.as_ref() {
                    args.SetHandled(true)?;
                }
                let _ = previous_app.emit(MEDIA_CONTROL_EVENT, "previous");
                Ok(())
            }))
            .map_err(|error| error.to_string())?;

        let button_pressed_app = app.clone();
        let button_pressed_token = controls
            .ButtonPressed(&TypedEventHandler::<
                SystemMediaTransportControls,
                SystemMediaTransportControlsButtonPressedEventArgs,
            >::new(move |_sender, args| {
                let Some(args) = args.as_ref() else {
                    return Ok(());
                };
                let action = match args.Button()? {
                    SystemMediaTransportControlsButton::Next => Some("next"),
                    SystemMediaTransportControlsButton::Previous => Some("previous"),
                    _ => None,
                };
                if let Some(action) = action {
                    let _ = button_pressed_app.emit(MEDIA_CONTROL_EVENT, action);
                }
                Ok(())
            }))
            .map_err(|error| error.to_string())?;

        let taskbar_toolbar = ThumbnailToolbar::new(&app).ok();

        Ok(Self {
            _player: player,
            _command_manager: command_manager,
            controls,
            metadata: Mutex::new(None),
            taskbar_toolbar: Mutex::new(taskbar_toolbar),
            _play_token: play_token,
            _pause_token: pause_token,
            _next_token: next_token,
            _previous_token: previous_token,
            _button_pressed_token: button_pressed_token,
        })
    }

    fn update(&self, update: MediaSessionUpdate) -> Result<(), String> {
        self.update_metadata(
            MediaMetadata::from_update(&update),
            update.force_metadata.unwrap_or(false),
        )?;
        self.update_timeline(&update)?;

        let status = match update.status.as_str() {
            "playing" => MediaPlaybackStatus::Playing,
            "paused" => MediaPlaybackStatus::Paused,
            "loading" => MediaPlaybackStatus::Changing,
            _ => MediaPlaybackStatus::Stopped,
        };
        self.controls
            .SetPlaybackStatus(status)
            .map_err(|error| error.to_string())?;
        self.update_taskbar_toolbar(&update)
    }

    fn update_metadata(
        &self,
        next_metadata: Option<MediaMetadata>,
        force_metadata: bool,
    ) -> Result<(), String> {
        let mut current_metadata = self.metadata.lock().map_err(|error| error.to_string())?;
        if !force_metadata && *current_metadata == next_metadata {
            return Ok(());
        }

        let updater = self
            .controls
            .DisplayUpdater()
            .map_err(|error| error.to_string())?;

        updater.ClearAll().map_err(|error| error.to_string())?;

        if let Some(metadata) = next_metadata.as_ref() {
            updater
                .SetType(MediaPlaybackType::Music)
                .and_then(|_| updater.MusicProperties())
                .and_then(|properties| {
                    properties.SetTitle(&HSTRING::from(metadata.title.as_str()))?;
                    properties.SetArtist(&HSTRING::from(metadata.artist.as_str()))
                })
                .map_err(|error| error.to_string())?;

            if let Some(artwork_url) = metadata.artwork_url.as_ref() {
                if let Ok(uri) = Uri::CreateUri(&HSTRING::from(artwork_url.as_str())) {
                    if let Ok(thumbnail) = RandomAccessStreamReference::CreateFromUri(&uri) {
                        updater
                            .SetThumbnail(&thumbnail)
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
        }

        updater.Update().map_err(|error| error.to_string())?;
        *current_metadata = next_metadata;
        Ok(())
    }

    fn update_timeline(&self, update: &MediaSessionUpdate) -> Result<(), String> {
        let Some(duration_sec) = update.duration_sec else {
            return Ok(());
        };
        if !duration_sec.is_finite() || duration_sec <= 0.0 {
            return Ok(());
        }

        let position_sec = update
            .position_sec
            .filter(|position| position.is_finite())
            .unwrap_or(0.0)
            .clamp(0.0, duration_sec);

        let timeline = SystemMediaTransportControlsTimelineProperties::new()
            .map_err(|error| error.to_string())?;
        timeline
            .SetStartTime(duration_to_timespan(0.0))
            .and_then(|_| timeline.SetEndTime(duration_to_timespan(duration_sec)))
            .and_then(|_| timeline.SetMinSeekTime(duration_to_timespan(0.0)))
            .and_then(|_| timeline.SetMaxSeekTime(duration_to_timespan(duration_sec)))
            .and_then(|_| timeline.SetPosition(duration_to_timespan(position_sec)))
            .map_err(|error| error.to_string())?;
        self.controls
            .UpdateTimelineProperties(&timeline)
            .map_err(|error| error.to_string())
    }

    fn update_taskbar_toolbar(&self, update: &MediaSessionUpdate) -> Result<(), String> {
        let mut toolbar = self
            .taskbar_toolbar
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(toolbar) = toolbar.as_mut() else {
            return Ok(());
        };

        toolbar.update(update.status.as_str())
    }
}

impl MediaMetadata {
    fn from_update(update: &MediaSessionUpdate) -> Option<Self> {
        Some(Self {
            title: update.title.clone()?,
            artist: update.artist.clone().unwrap_or_default(),
            artwork_url: update.artwork_url.clone(),
        })
    }
}

fn duration_to_timespan(seconds: f64) -> windows::Foundation::TimeSpan {
    windows::Foundation::TimeSpan {
        Duration: (seconds * 10_000_000.0).round() as i64,
    }
}

struct ThumbnailToolbar {
    hwnd: HWND,
    taskbar: ITaskbarList3,
    app_handle: *mut AppHandle,
    previous_icon: HICON,
    play_icon: HICON,
    pause_icon: HICON,
    next_icon: HICON,
    is_playing: bool,
}

unsafe impl Send for ThumbnailToolbar {}

impl ThumbnailToolbar {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window unavailable".to_string())?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;

        initialize_com_for_taskbar()?;
        let taskbar: ITaskbarList3 =
            unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| error.to_string())?;
        unsafe { taskbar.HrInit() }.map_err(|error| error.to_string())?;

        let previous_icon = create_taskbar_icon(TaskbarIconKind::Previous)?;
        let play_icon = create_taskbar_icon(TaskbarIconKind::Play)?;
        let pause_icon = create_taskbar_icon(TaskbarIconKind::Pause)?;
        let next_icon = create_taskbar_icon(TaskbarIconKind::Next)?;
        let app_handle = Box::into_raw(Box::new(app.clone()));

        let subclass_set = unsafe {
            SetWindowSubclass(
                hwnd,
                Some(taskbar_subclass_proc),
                TASKBAR_SUBCLASS_ID,
                app_handle as usize,
            )
        };
        if !subclass_set.as_bool() {
            unsafe {
                drop(Box::from_raw(app_handle));
                let _ = DestroyIcon(previous_icon);
                let _ = DestroyIcon(play_icon);
                let _ = DestroyIcon(pause_icon);
                let _ = DestroyIcon(next_icon);
            }
            return Err("taskbar control window hook failed".to_string());
        }

        let toolbar = Self {
            hwnd,
            taskbar,
            app_handle,
            previous_icon,
            play_icon,
            pause_icon,
            next_icon,
            is_playing: false,
        };
        toolbar.add_buttons()?;
        Ok(toolbar)
    }

    fn add_buttons(&self) -> Result<(), String> {
        let buttons = self.buttons("Play", self.play_icon, THUMBBUTTONFLAGS(0));
        unsafe { self.taskbar.ThumbBarAddButtons(self.hwnd, &buttons) }
            .map_err(|error| error.to_string())
    }

    fn update(&mut self, status: &str) -> Result<(), String> {
        let is_playing = status == "playing" || status == "loading";
        if self.is_playing == is_playing {
            return Ok(());
        }

        self.is_playing = is_playing;
        let (tooltip, icon) = if is_playing {
            ("Pause", self.pause_icon)
        } else {
            ("Play", self.play_icon)
        };
        let buttons = self.buttons(tooltip, icon, THUMBBUTTONFLAGS(0));
        unsafe { self.taskbar.ThumbBarUpdateButtons(self.hwnd, &buttons) }
            .map_err(|error| error.to_string())
    }

    fn buttons(
        &self,
        play_pause_tooltip: &str,
        play_pause_icon: HICON,
        flags: THUMBBUTTONFLAGS,
    ) -> [THUMBBUTTON; 3] {
        [
            taskbar_button(
                TASKBAR_BUTTON_PREVIOUS,
                self.previous_icon,
                "Previous",
                flags,
            ),
            taskbar_button(
                TASKBAR_BUTTON_PLAY_PAUSE,
                play_pause_icon,
                play_pause_tooltip,
                flags,
            ),
            taskbar_button(TASKBAR_BUTTON_NEXT, self.next_icon, "Next", flags),
        ]
    }
}

impl Drop for ThumbnailToolbar {
    fn drop(&mut self) {
        unsafe {
            let _ = RemoveWindowSubclass(
                self.hwnd,
                Some(taskbar_subclass_proc),
                TASKBAR_SUBCLASS_ID,
            );
            drop(Box::from_raw(self.app_handle));
            let _ = DestroyIcon(self.previous_icon);
            let _ = DestroyIcon(self.play_icon);
            let _ = DestroyIcon(self.pause_icon);
            let _ = DestroyIcon(self.next_icon);
        }
    }
}

fn initialize_com_for_taskbar() -> Result<(), String> {
    let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if result.is_ok() || result == RPC_E_CHANGED_MODE {
        Ok(())
    } else {
        Err(result.message())
    }
}

fn taskbar_button(id: u32, icon: HICON, tooltip: &str, flags: THUMBBUTTONFLAGS) -> THUMBBUTTON {
    let mut button = THUMBBUTTON {
        dwMask: THUMBBUTTONMASK(THB_ICON.0 | THB_TOOLTIP.0 | THB_FLAGS.0),
        iId: id,
        iBitmap: 0,
        hIcon: icon,
        szTip: [0; 260],
        dwFlags: flags,
    };

    for (index, unit) in tooltip
        .encode_utf16()
        .take(button.szTip.len() - 1)
        .enumerate()
    {
        button.szTip[index] = unit;
    }

    button
}

unsafe extern "system" fn taskbar_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    if message == WM_COMMAND {
        let command_id = (wparam.0 & 0xffff) as u32;
        let notification_code = ((wparam.0 >> 16) & 0xffff) as u16;
        if notification_code == THBN_CLICKED {
            let action = match command_id {
                TASKBAR_BUTTON_PREVIOUS => Some("previous"),
                TASKBAR_BUTTON_PLAY_PAUSE => Some("playPause"),
                TASKBAR_BUTTON_NEXT => Some("next"),
                _ => None,
            };
            if let Some(action) = action {
                let app = unsafe { &*(ref_data as *const AppHandle) };
                let _ = app.emit(MEDIA_CONTROL_EVENT, action);
                return LRESULT(0);
            }
        }
    }

    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

enum TaskbarIconKind {
    Previous,
    Play,
    Pause,
    Next,
}

fn create_taskbar_icon(kind: TaskbarIconKind) -> Result<HICON, String> {
    const SIZE: usize = 16;
    let mut pixels = [0_u8; SIZE * SIZE * 4];
    let color = [255, 255, 255, 255];

    match kind {
        TaskbarIconKind::Previous => {
            fill_rect(&mut pixels, 3, 3, 4, 10, color);
            draw_left_triangle(&mut pixels, 5, 8, 7, color);
        }
        TaskbarIconKind::Play => {
            draw_right_triangle(&mut pixels, 4, 8, 8, color);
        }
        TaskbarIconKind::Pause => {
            fill_rect(&mut pixels, 4, 3, 3, 10, color);
            fill_rect(&mut pixels, 9, 3, 3, 10, color);
        }
        TaskbarIconKind::Next => {
            draw_right_triangle(&mut pixels, 4, 8, 7, color);
            fill_rect(&mut pixels, 10, 3, 4, 10, color);
        }
    }

    let and_mask = [0_u8; SIZE * SIZE / 8];
    unsafe {
        CreateIcon(
            None,
            SIZE as i32,
            SIZE as i32,
            1,
            32,
            and_mask.as_ptr(),
            pixels.as_ptr(),
        )
    }
    .map_err(|error| error.to_string())
}

fn set_icon_pixel(pixels: &mut [u8], x: usize, y: usize, color: [u8; 4]) {
    if x >= 16 || y >= 16 {
        return;
    }
    let index = ((15 - y) * 16 + x) * 4;
    pixels[index] = color[2];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[0];
    pixels[index + 3] = color[3];
}

fn fill_rect(pixels: &mut [u8], x: usize, y: usize, width: usize, height: usize, color: [u8; 4]) {
    for py in y..y + height {
        for px in x..x + width {
            set_icon_pixel(pixels, px, py, color);
        }
    }
}

fn draw_right_triangle(
    pixels: &mut [u8],
    x: usize,
    center_y: usize,
    radius: usize,
    color: [u8; 4],
) {
    for offset in 0..=radius {
        let half_height = offset / 2 + 1;
        for py in center_y.saturating_sub(half_height)..=center_y + half_height {
            set_icon_pixel(pixels, x + radius - offset, py, color);
        }
    }
}

fn draw_left_triangle(pixels: &mut [u8], x: usize, center_y: usize, radius: usize, color: [u8; 4]) {
    for offset in 0..=radius {
        let half_height = offset / 2 + 1;
        for py in center_y.saturating_sub(half_height)..=center_y + half_height {
            set_icon_pixel(pixels, x + offset, py, color);
        }
    }
}

#[tauri::command]
pub fn update_windows_media_session(
    app: AppHandle,
    state: tauri::State<'_, WindowsMediaSession>,
    update: MediaSessionUpdate,
) -> Result<(), String> {
    state.with_session(&app, |session| session.update(update))
}
