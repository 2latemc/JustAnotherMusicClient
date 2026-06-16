import type { DataSource } from "../datasource/DataSource";
import type {
  Album,
  Artist,
  ArtistPage,
  AuthPrompt,
  LibrarySnapshot,
  Playlist,
  Track,
} from "../datasource/types";
import { logInternalError, logInternalInfo } from "../internal/logging";

export type LibraryStatus = "restoring" | "signed-out" | "authorizing" | "loading" | "ready" | "error";

export interface LibraryState {
  status: LibraryStatus;
  authPrompt: AuthPrompt | null;
  library: LibrarySnapshot | null;
  pendingLikeTrackIds: ReadonlySet<string>;
  error: string | null;
}

type Listener = () => void;

export class LibraryController {
  private readonly listeners = new Set<Listener>();
  private initializationPromise: Promise<void> | null = null;
  private state: LibraryState = {
    status: "restoring",
    authPrompt: null,
    library: null,
    pendingLikeTrackIds: new Set(),
    error: null,
  };

  constructor(private readonly dataSource: DataSource) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): LibraryState {
    return this.state;
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.restoreSession();
    return this.initializationPromise;
  }

  async recoverConnection(): Promise<void> {
    if (this.state.status === "authorizing") return;

    try {
      const restored = await this.dataSource.restoreSession?.();
      if (restored) {
        await this.refresh();
        return;
      }

      if (this.state.library) {
        await this.refresh();
      } else {
        this.setState({ status: "signed-out", authPrompt: null, error: null });
      }
    } catch (error) {
      this.setFailure("Unable to restore your YouTube Music session.", error);
    }
  }

  private async restoreSession(): Promise<void> {
    try {
      const cachedLibrary = await this.dataSource.getCachedLibrary?.();
      if (cachedLibrary) {
        this.setState({ library: cachedLibrary, error: null });
      }

      const restored = await this.dataSource.restoreSession?.();
      if (!restored) {
        this.setState({ status: "signed-out", authPrompt: null, error: null });
        return;
      }
      await this.refresh();
    } catch (error) {
      this.setFailure("Unable to restore your YouTube Music session.", error);
    }
  }

  async signIn(): Promise<void> {
    if (!this.dataSource.signIn) return;
    logInternalInfo("LibraryController.signIn start");
    this.setState({ status: "authorizing", authPrompt: null, error: null });
    try {
      await this.dataSource.signIn((authPrompt) => {
        logInternalInfo("LibraryController.signIn prompt received", {
          verificationUrl: authPrompt.verificationUrl,
          expiresInSec: authPrompt.expiresInSec,
        });
        this.setState({ status: "authorizing", authPrompt, error: null });
      });
      logInternalInfo("LibraryController.signIn authentication complete");
      await this.refresh();
      logInternalInfo("LibraryController.signIn refresh complete");
    } catch (error) {
      this.setFailure("YouTube Music sign-in failed.", error);
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.dataSource.signOut?.();
      this.setState({
        status: "signed-out",
        authPrompt: null,
        library: null,
        pendingLikeTrackIds: new Set(),
        error: null,
      });
    } catch (error) {
      this.setFailure("Unable to sign out.", error);
    }
  }

  async refresh(): Promise<void> {
    if (!this.dataSource.getLibrary) return;
    this.setState({ status: "loading", authPrompt: null, error: null });
    try {
      const library = await this.dataSource.getLibrary((updatedLibrary) => {
        this.setState({ status: "ready", library: updatedLibrary, authPrompt: null, error: null });
      });
      this.setState({ status: "ready", library, authPrompt: null, error: null });
      logInternalInfo("LibraryController.refresh success", {
        albumCount: library.albums.length,
        playlistCount: library.playlists.length,
        likedSongCount: library.likedSongs.length,
        recentTrackCount: library.recentlyPlayed.length,
      });
    } catch (error) {
      this.setFailure("Unable to load your YouTube Music library.", error);
    }
  }

  async getAlbumTracks(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    if (!this.dataSource.getAlbumTracks) return [];
    return this.dataSource.getAlbumTracks(album, onUpdate);
  }

  async getArtist(
    artistId: string,
    onUpdate?: (artist: ArtistPage) => void,
  ): Promise<ArtistPage> {
    if (!this.dataSource.getArtist) {
      throw new Error("Artist pages are unavailable.");
    }
    return this.dataSource.getArtist(artistId, onUpdate);
  }

  async setArtistSubscribed(artist: Artist, subscribed: boolean): Promise<void> {
    if (!this.dataSource.setArtistSubscribed) {
      throw new Error("Subscribing to artists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update subscriptions.");
    }
    if (!artist.id.startsWith("UC")) {
      throw new Error("This artist does not have a subscribable channel.");
    }
    return this.dataSource.setArtistSubscribed(artist.id, subscribed);
  }

  isAlbumSaved(albumId: string): boolean {
    return this.state.library?.albums.some((album) => album.id === albumId) ?? false;
  }

  async setAlbumSaved(album: Album, saved: boolean): Promise<void> {
    if (!this.dataSource.setAlbumSaved) {
      throw new Error("Saving albums is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }

    const previousLibrary = this.state.library;
    const albums = saved
      ? [album, ...previousLibrary.albums.filter((item) => item.id !== album.id)]
      : previousLibrary.albums.filter((item) => item.id !== album.id);
    this.setState({ library: { ...previousLibrary, albums } });

    try {
      await this.dataSource.setAlbumSaved(album, saved);
      void this.refresh();
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    }
  }

  async getPlaylistTracks(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    if (!this.dataSource.getPlaylistTracks) return [];
    return this.dataSource.getPlaylistTracks(playlist, onUpdate);
  }

  async getRecommendations(seed: Track): Promise<Track[]> {
    return this.dataSource.getRecommendations?.(seed) ?? [];
  }

  async addTrackToPlaylist(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present"> {
    if (!this.dataSource.addTrackToPlaylist) {
      throw new Error("Adding songs to playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music before adding songs to playlists.");
    }
    return this.dataSource.addTrackToPlaylist(track, playlist);
  }

  async removeTrackFromPlaylist(track: Track, playlist: Playlist): Promise<void> {
    if (!this.dataSource.removeTrackFromPlaylist) {
      logInternalError("LibraryController.removeTrackFromPlaylist unavailable", {
        dataSource: this.dataSource.constructor.name,
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("Removing songs from playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music before removing songs from playlists.");
    }
    return this.dataSource.removeTrackFromPlaylist(track, playlist);
  }

  isPlaylistSaved(playlistId: string): boolean {
    const normalizedId = playlistId.replace(/^VL/, "");
    return this.state.library?.playlists.some(
      (playlist) => playlist.id.replace(/^VL/, "") === normalizedId,
    ) ?? false;
  }

  async setPlaylistSaved(playlist: Playlist, saved: boolean): Promise<void> {
    if (!this.dataSource.setPlaylistSaved) {
      throw new Error("Saving playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }

    const previousLibrary = this.state.library;
    const normalizedId = playlist.id.replace(/^VL/, "");
    const playlists = saved
      ? [
          { ...playlist, isSaved: true, isEditable: playlist.isEditable ?? false },
          ...previousLibrary.playlists.filter(
            (item) => item.id.replace(/^VL/, "") !== normalizedId,
          ),
        ]
      : previousLibrary.playlists.filter(
          (item) => item.id.replace(/^VL/, "") !== normalizedId,
        );
    this.setState({ library: { ...previousLibrary, playlists } });

    try {
      await this.dataSource.setPlaylistSaved(playlist, saved);
      void this.refresh();
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    }
  }

  isTrackLiked(trackId: string): boolean {
    return this.state.library?.likedSongs.some((track) => track.id === trackId) ?? false;
  }

  async setTrackLiked(track: Track, liked: boolean): Promise<void> {
    if (!this.dataSource.setTrackLiked) {
      throw new Error("Liking songs is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to like");
    }
    if (this.state.pendingLikeTrackIds.has(track.id)) return;

    const previousLibrary = this.state.library;
    const pendingLikeTrackIds = new Set(this.state.pendingLikeTrackIds);
    pendingLikeTrackIds.add(track.id);
    const likedSongs = liked
      ? [track, ...previousLibrary.likedSongs.filter((item) => item.id !== track.id)]
      : previousLibrary.likedSongs.filter((item) => item.id !== track.id);

    this.setState({
      library: { ...previousLibrary, likedSongs },
      pendingLikeTrackIds,
    });

    try {
      await this.dataSource.setTrackLiked(track, liked);
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    } finally {
      const nextPending = new Set(this.state.pendingLikeTrackIds);
      nextPending.delete(track.id);
      this.setState({ pendingLikeTrackIds: nextPending });
    }
  }

  private setFailure(message: string, error: unknown) {
    logInternalError("LibraryController operation failed", error);
    this.setState({ status: "error", error: message, authPrompt: null });
  }

  private setState(partial: Partial<LibraryState>) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}
