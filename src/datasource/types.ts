export type TrackSource = "youtube";

export interface ArtistReference {
  id: string;
  name: string;
}

export interface Track {
  id: string;
  source: TrackSource;
  title: string;
  artist: string;
  artists?: ArtistReference[];
  album?: string;
  durationSec?: number;
  artworkUrl?: string;
  playlistItemId?: string;
  viewCount?: number;
  viewCountText?: string;
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
  playlistId?: string;
  title: string;
  artist: string;
  artists?: ArtistReference[];
  artworkUrl?: string;
  releaseType?: "album" | "single" | "ep";
}

export interface Playlist {
  id: string;
  title: string;
  owner: string;
  artworkUrl?: string;
  kind?: "playlist" | "liked-songs";
  isSaved?: boolean;
  isEditable?: boolean;
}

export interface Artist {
  id: string;
  name: string;
  artworkUrl?: string;
  subscriberCount?: string;
}

export interface ArtistPage {
  artist: Artist;
  subscribed?: boolean;
  popularSongs: Track[];
  allSongs: Track[];
  releases: Album[];
  playlists: Playlist[];
}

export interface SearchResults {
  artists: Artist[];
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
}

export interface TrackPage {
  tracks: Track[];
  nextPageKey?: string;
  hasMore: boolean;
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
