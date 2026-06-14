export type TrackSource = "youtube";

export interface Track {
  id: string;
  source: TrackSource;
  title: string;
  artist: string;
  durationSec?: number;
  artworkUrl?: string;
  playlistItemId?: string;
}

export interface LyricLine {
  text: string;
  startTimeSec?: number;
  endTimeSec?: number;
}

export interface Lyrics {
  lines: LyricLine[];
  timing: "synced" | "estimated" | "none";
  sourceLabel?: string;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string;
}

export interface Playlist {
  id: string;
  title: string;
  owner: string;
  artworkUrl?: string;
  kind?: "playlist" | "liked-songs";
}

export interface AuthPrompt {
  verificationUrl: string;
  userCode: string;
  expiresInSec: number;
}

export interface AccountProfile {
  name: string;
  artworkUrl?: string;
}

export interface LibrarySnapshot {
  account: AccountProfile;
  albums: Album[];
  playlists: Playlist[];
  likedSongsPlaylist: Playlist;
  likedSongs: Track[];
  recentlyPlayed: Track[];
}
