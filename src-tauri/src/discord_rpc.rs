use discord_rich_presence::activity::{Activity, Assets, Button};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DISCORD_CLIENT_ID: &str = "1515682467154100344";
const GITHUB_REPO: &str = "https://github.com/2latemc/JustAnotherMusicClient";
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscordPresenceData {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork_url: Option<String>,
    pub duration: u64,
    pub current_time: u64,
    pub is_playing: bool,
}

pub struct DiscordRpcManager {
    client: Arc<Mutex<Option<DiscordIpcClient>>>,
    connected: Arc<Mutex<bool>>,
}

impl DiscordRpcManager {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            connected: Arc::new(Mutex::new(false)),
        }
    }

    /// Initialize Discord RPC connection
    pub fn connect(&self) -> Result<(), String> {
        let mut client_lock = self.client.lock().map_err(|e| e.to_string())?;

        if client_lock.is_some() {
            return Ok(());
        }

        match DiscordIpcClient::new(DISCORD_CLIENT_ID) {
            Ok(mut client) => {
                if let Err(e) = client.connect() {
                    return Err(format!("Failed to connect to Discord: {}", e));
                }
                *client_lock = Some(client);
                let mut connected = self.connected.lock().map_err(|e| e.to_string())?;
                *connected = true;
                Ok(())
            }
            Err(e) => Err(format!("Failed to create Discord client: {}", e)),
        }
    }

    /// Update Discord presence with current track info
    pub fn update_presence(&self, data: DiscordPresenceData) -> Result<(), String> {
        // Ensure connection exists
        if !*self.connected.lock().map_err(|e| e.to_string())? {
            self.connect()?;
        }

        let mut client_lock = self.client.lock().map_err(|e| e.to_string())?;

        let client = client_lock.as_mut().ok_or("Discord client not initialized")?;

        // Calculate progress
        let elapsed = data.current_time;
        let duration = data.duration;

        // Keep owned values alive while building the activity
        let state_str = if data.is_playing {
            data.artist.clone()
        } else {
            format!("{} (paused)", data.artist)
        };

        let artwork_image = data.artwork_url.clone();
        let artwork_key = artwork_image.as_deref().unwrap_or("app-icon");

        let large_text_str = format!("{} - {}", data.title, data.artist);

        let start_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
            - elapsed as i64;
        let end_ts = start_ts + duration as i64;

        // Build activity: details = song title (main line), state = artist (subtitle)
        let mut activity = Activity::new()
            .details(&data.title)
            .state(&state_str);

        if duration > 0 {
            activity = activity.timestamps(
                discord_rich_presence::activity::Timestamps::new()
                    .start(start_ts)
                    .end(end_ts),
            );
        }

        activity = activity.assets(
            Assets::new().large_image(artwork_key).large_text(&large_text_str),
        );

        // Add download client button
        activity = activity.buttons(vec![Button::new("Download Client", GITHUB_REPO)]);

        // Set the activity
        if let Err(e) = client.set_activity(activity) {
            eprintln!("[Discord RPC] Failed to set activity: {}", e);
            *client_lock = None;
            if let Ok(mut connected) = self.connected.lock() {
                *connected = false;
            }
        }

        Ok(())
    }

    /// Clear presence (show idle)
    pub fn clear_presence(&self) -> Result<(), String> {
        if !*self.connected.lock().map_err(|e| e.to_string())? {
            return Ok(());
        }

        let mut client_lock = self.client.lock().map_err(|e| e.to_string())?;
        let client = client_lock.as_mut().ok_or("Discord client not initialized")?;

        if let Err(e) = client.clear_activity() {
            eprintln!("[Discord RPC] Failed to clear activity: {}", e);
            *client_lock = None;
            if let Ok(mut connected) = self.connected.lock() {
                *connected = false;
            }
        }

        Ok(())
    }
}

impl Default for DiscordRpcManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discord_rpc_manager_creation() {
        let manager = DiscordRpcManager::new();
        assert!(!*manager.connected.lock().unwrap());
    }
}
