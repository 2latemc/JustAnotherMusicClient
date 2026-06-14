import type { Album, AuthPrompt, LibrarySnapshot, Lyrics, Playlist, Track } from "./types";

export type StreamData = {
  bytes: ArrayBuffer;
  mimeType?: string;
};

export abstract class DataSource {
  abstract getTrack(id: string): Promise<Track>;
  abstract getStreamUrl(track: Track): Promise<string>;
  searchTracks?(query: string, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  getSearchSuggestions?(query: string, onUpdate?: (suggestions: string[]) => void): Promise<string[]>;
  getStreamData?(track: Track): Promise<StreamData>;
  restoreSession?(): Promise<boolean>;
  signIn?(onPrompt: (prompt: AuthPrompt) => void): Promise<void>;
  signOut?(): Promise<void>;
  getCachedLibrary?(): Promise<LibrarySnapshot | null>;
  getLibrary?(onUpdate?: (library: LibrarySnapshot) => void): Promise<LibrarySnapshot>;
  getAlbumTracks?(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  getPlaylistTracks?(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  addTrackToPlaylist?(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present">;
  removeTrackFromPlaylist?(track: Track, playlist: Playlist): Promise<void>;
  setTrackLiked?(track: Track, liked: boolean): Promise<void>;
  getRecommendations?(seed: Track, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  getLyrics?(track: Track): Promise<Lyrics | null>;
}
