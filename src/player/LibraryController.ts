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
const LIBRARY_REFRESH_TIMEOUT_MS = 20_000;
const SIGN_IN_REFRESH_RETRY_DELAYS_MS = [0, 1_500, 5_000];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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
      await this.refreshAfterSignIn();
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

  async refresh(options: { suppressFailure?: boolean } = {}): Promise<void> {
    if (!this.dataSource.getLibrary) return;
    this.setState({ status: "loading", authPrompt: null, error: null });
    try {
      const library = await withTimeout(
        this.dataSource.getLibrary((updatedLibrary) => {
          this.setState({ status: "ready", library: updatedLibrary, authPrompt: null, error: null });
        }),
        LIBRARY_REFRESH_TIMEOUT_MS,
        "YouTube Music library sync timed out.",
      );
      this.applyLibrary(library);
    } catch (error) {
      if (options.suppressFailure) throw error;
      this.setFailure("Unable to load your YouTube Music library.", error);
    }
  }

  private applyLibrary(library: LibrarySnapshot): void {
    this.setState({ status: "ready", library, authPrompt: null, error: null });
    logInternalInfo("LibraryController.refresh success", {
      albumCount: library.albums.length,
      playlistCount: library.playlists.length,
      likedSongCount: library.likedSongs.length,
      recentTrackCount: library.recentlyPlayed.length,
    });
  }

  private hasCompleteEnoughLibrary(library: LibrarySnapshot | null): boolean {
    if (!library) return false;
    return library.playlists.length > 0
      || library.albums.length > 0
      || library.likedSongs.length > 0;
  }

  private async refreshAfterSignIn(): Promise<void> {
    let lastError: unknown = null;

    for (let index = 0; index < SIGN_IN_REFRESH_RETRY_DELAYS_MS.length; index += 1) {
      const delayMs = SIGN_IN_REFRESH_RETRY_DELAYS_MS[index];
      if (delayMs > 0) await delay(delayMs);

      try {
        await this.refresh({ suppressFailure: true });
        if (this.hasCompleteEnoughLibrary(this.state.library)) return;

        logInternalInfo("LibraryController.signIn retrying incomplete library", {
          attempt: index + 1,
          playlistCount: this.state.library?.playlists.length ?? 0,
          albumCount: this.state.library?.albums.length ?? 0,
          likedSongCount: this.state.library?.likedSongs.length ?? 0,
          recentTrackCount: this.state.library?.recentlyPlayed.length ?? 0,
        });
      } catch (error) {
        lastError = error;
        logInternalInfo("LibraryController.signIn library retry failed", {
          attempt: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.state.library) return;
    throw lastError ?? new Error("YouTube Music library did not finish syncing after sign-in.");
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
    return this.state.library?.albums.some((album) =>
      album.id === albumId || album.playlistId === albumId
    ) ?? false;
  }

  async setAlbumSaved(album: Album, saved: boolean): Promise<void> {
    if (!this.dataSource.setAlbumSaved) {
      throw new Error("Saving albums is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }

    const previousLibrary = this.state.library;
    const sameAlbum = (item: Album) =>
      item.id === album.id
      || Boolean(album.playlistId && item.playlistId === album.playlistId)
      || Boolean(album.playlistId && item.id === album.playlistId)
      || Boolean(item.playlistId && item.playlistId === album.id);
    const albums = saved
      ? [album, ...previousLibrary.albums.filter((item) => !sameAlbum(item))]
      : previousLibrary.albums.filter((item) => !sameAlbum(item));
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
    const detail = error instanceof Error ? error.message : String(error);
    this.setState({
      status: "error",
      error: detail && detail !== "[object Object]" ? `${message}\n\n${detail}` : message,
      authPrompt: null,
    });
  }

  private setState(partial: Partial<LibraryState>) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}
