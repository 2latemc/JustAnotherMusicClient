import type { DataSource } from "../datasource/DataSource";
import type { Lyrics, Track } from "../datasource/types";
import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../internal/logging";
import { AudioEngine } from "./AudioEngine";
import { Queue } from "./Queue";

export type PlaybackOrderMode = "in-order" | "shuffle" | "repeat-one";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface PlayerState {
  status: PlayerStatus;
  currentTrack: Track | null;
  history: Track[];
  error: string | null;
  playbackOrderMode: PlaybackOrderMode;
}

export interface PlayerSession {
  currentTrack: Track | null;
  history: Track[];
  queue: Track[];
  queueIndex: number;
  manualQueueLength?: number;
  status: "playing" | "paused" | "idle";
  positionSec: number;
  volume: number;
  muted: boolean;
  autoplayEnabled: boolean;
  playbackOrderMode: PlaybackOrderMode;
}

type Listener = () => void;

function normalizePlaybackOrderMode(mode: unknown): PlaybackOrderMode {
  if (mode === "shuffle") return "shuffle";
  if (mode === "repeat-one" || mode === "repeat-all") return "repeat-one";
  return "in-order";
}

export class PlayerController {
  private readonly audioEngine = new AudioEngine();
  private readonly queue = new Queue();
  private readonly listeners = new Set<Listener>();
  private readonly recommendationHistory = new Map<string, string[]>();
  private loadedTrackId: string | null = null;
  private isTabActive = false;
  private playTrackRequestId = 0;
  private autoplayEnabled = false;
  private handlingTrackEnd = false;
  private pendingSeekTime: number | null = null;
  private radioQueueRequestId = 0;
  private navigationRequest: Promise<void> = Promise.resolve();
  private playbackOrderMode: PlaybackOrderMode = "in-order";

  private state: PlayerState = {
    status: "idle",
    currentTrack: null,
    history: [],
    error: null,
    playbackOrderMode: "in-order",
  };

  constructor(private readonly dataSource: DataSource) {
    this.audioEngine.setOnEnded(() => {
      void this.handleTrackEnded();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PlayerState {
    return this.state;
  }

  exportSession(): PlayerSession {
    return {
      currentTrack: this.state.currentTrack,
      history: this.state.history.slice(-100),
      queue: [...this.queue.all],
      queueIndex: this.queue.currentIndex,
      manualQueueLength: this.queue.queuedManually,
      status: this.state.currentTrack
        ? (this.state.status === "playing" ? "playing" : "paused")
        : "idle",
      positionSec: this.loadedTrackId
        ? this.audioEngine.getCurrentTime()
        : (this.pendingSeekTime ?? 0),
      volume: this.audioEngine.getVolume(),
      muted: this.audioEngine.isMuted(),
      autoplayEnabled: this.autoplayEnabled,
      playbackOrderMode: this.playbackOrderMode,
    };
  }

  restoreSession(session: PlayerSession): void {
    this.playTrackRequestId += 1;
    this.audioEngine.stop();
    this.loadedTrackId = null;
    this.queue.set(
      [...session.queue],
      session.queueIndex,
      session.manualQueueLength ?? 0,
    );
    this.autoplayEnabled = session.autoplayEnabled;
    this.pendingSeekTime = Math.max(0, session.positionSec);
    this.audioEngine.setVolume(session.volume);
    this.audioEngine.setMuted(session.muted);
    this.playbackOrderMode = normalizePlaybackOrderMode(session.playbackOrderMode);
    this.state = {
      status: session.currentTrack ? session.status : "idle",
      currentTrack: session.currentTrack,
      history: session.history,
      error: null,
      playbackOrderMode: this.playbackOrderMode,
    };
    this.emit();
  }

  async loadTrack(track: Track): Promise<void> {
    logInternalInfo("PlayerController.loadTrack start", { trackId: track.id });
    this.pendingSeekTime = null;
    this.setState({ status: "loading", error: null });
    try {
      this.loadedTrackId = null;
      this.setState({
        currentTrack: track,
        history: this.appendHistory(track),
        status: "paused",
        error: null,
      });
      logInternalInfo("PlayerController.loadTrack success", {
        trackId: track.id,
        title: track.title,
      });
    } catch (error) {
      this.setError(error);
    }
  }

  async playTrackById(
    videoId: string,
    playbackQueue?: readonly Track[],
    autoplayWhenQueueEnds = false,
  ): Promise<boolean> {
    const requestId = ++this.playTrackRequestId;
    logInternalInfo("PlayerController.playTrackById start", { videoId });
    this.audioEngine.stop();
    this.audioEngine.silenceCompetingPlayback();
    this.loadedTrackId = null;
    this.pendingSeekTime = null;
    this.setState({ status: "loading", error: null });
    try {
      if (playbackQueue?.length) {
        const startIndex = playbackQueue.findIndex((track) => track.id === videoId);
        this.queue.set([...playbackQueue], startIndex >= 0 ? startIndex : 0);
        this.autoplayEnabled = autoplayWhenQueueEnds;
      }

      const track = await this.dataSource.getTrack(videoId);
      if (requestId !== this.playTrackRequestId) return false;

      this.loadedTrackId = null;
      this.setState({
        currentTrack: track,
        history: this.appendHistory(track),
        status: "loading",
        error: null,
        playbackOrderMode: this.playbackOrderMode,
      });
      if (autoplayWhenQueueEnds && playbackQueue?.length === 1) {
        void this.primeRadioQueue(track, requestId);
      }
      await this.ensureTrackLoaded(track);
      if (requestId !== this.playTrackRequestId) return false;

      if (this.isTabActive) {
        const playbackStarted = await this.audioEngine.play();
        if (!playbackStarted) return false;
      }
      if (requestId !== this.playTrackRequestId) return false;

      this.setState({ status: "playing", error: null });
      logInternalInfo("PlayerController.playTrackById success", {
        trackId: track.id,
        title: track.title,
      });
      return true;
    } catch (error) {
      if (requestId !== this.playTrackRequestId) return false;
      this.setError(error);
      return false;
    }
  }

  async play(): Promise<void> {
    logInternalInfo("PlayerController.play start", {
      currentStatus: this.state.status,
      currentTrackId: this.state.currentTrack?.id ?? null,
    });
    try {
      let track = this.state.currentTrack;
      if (!track) {
        logInternalWarn("PlayerController.play no current track, loading fallback");

        if (this.loadedTrackId && this.loadedTrackId) {
          // Try to reload the last played track
          track = await this.dataSource.getTrack(this.loadedTrackId);
          this.setState({ currentTrack: track, status: "paused", error: null });
        }
      }

      if (!track) {
        throw new Error("No track available to play.");
      }

      const isResumingLoadedTrack = this.loadedTrackId === track.id;
      if (!isResumingLoadedTrack || this.state.status === "error") {
        this.setState({ status: "loading", error: null });
      }

      await this.ensureTrackLoaded(track);
      if (this.isTabActive) {
        const playbackStarted = this.audioEngine.play();
        if (isResumingLoadedTrack) {
          this.setState({ status: "playing", error: null });
        }
        if (!await playbackStarted) {
          this.setState({ status: "paused", error: null });
          return;
        }
        if (!isResumingLoadedTrack) {
          this.setState({ status: "playing", error: null });
        }
      } else {
        this.setState({ status: "paused", error: null });
      }

      logInternalInfo("PlayerController.play success", { trackId: track.id });
    } catch (error) {
      this.setError(error);
    }
  }

  async pause(): Promise<void> {
    logInternalInfo("PlayerController.pause start", {
      currentStatus: this.state.status,
      currentTrackId: this.state.currentTrack?.id ?? null,
    });
    try {
      this.audioEngine.pause();
      this.setState({ status: "paused", error: null });
      logInternalInfo("PlayerController.pause success");
    } catch (error) {
      this.setError(error);
    }
  }

  async togglePlayPause(): Promise<void> {
    logInternalDebug("PlayerController.togglePlayPause", { currentStatus: this.state.status });
    if (this.state.status === "playing") {
      await this.pause();
      return;
    }

    await this.play();
  }

  async skipToNext(): Promise<void> {
    return this.queueNavigation(() => this.skipToNextNow());
  }

  getPlaybackOrderMode(): PlaybackOrderMode {
    return this.playbackOrderMode;
  }

  setPlaybackOrderMode(mode: PlaybackOrderMode): void {
    this.playbackOrderMode = mode;
    this.setState({ playbackOrderMode: mode });
  }

  cyclePlaybackOrderMode(): void {
    const nextMode: PlaybackOrderMode = this.playbackOrderMode === "in-order"
      ? "shuffle"
      : this.playbackOrderMode === "shuffle"
        ? "repeat-one"
        : "in-order";
    this.setPlaybackOrderMode(nextMode);
  }

  addToQueue(track: Track): void {
    this.queue.add(track);
    this.emit();
    logInternalInfo("PlayerController.addToQueue", {
      trackId: track.id,
      title: track.title,
    });
  }

  playNext(track: Track): void {
    this.queue.playNext(track);
    this.emit();
    logInternalInfo("PlayerController.playNext", {
      trackId: track.id,
      title: track.title,
    });
  }

  removeFromQueueAt(index: number): void {
    this.queue.removeAt(index);
    this.emit();
    logInternalInfo("PlayerController.removeFromQueueAt", { index });
  }

  async playQueueTrackAt(index: number): Promise<boolean> {
    const track = this.queue.select(index);
    if (!track) return false;
    this.emit();
    return this.playTrackById(track.id);
  }

  moveQueueTrack(sourceIndex: number, targetIndex: number, insertAfter: boolean): void {
    this.queue.move(sourceIndex, targetIndex, insertAfter);
    this.emit();
    logInternalInfo("PlayerController.moveQueueTrack", {
      sourceIndex,
      targetIndex,
      insertAfter,
    });
  }

  private async skipToNextNow(): Promise<void> {
    const shouldResume = this.state.status === "playing";
    const nextTrack = this.playbackOrderMode === "shuffle"
      ? this.queue.nextRandom()
      : this.queue.next(false);
    if (
      (!nextTrack || nextTrack.id === this.state.currentTrack?.id)
      && this.autoplayEnabled
      && this.state.currentTrack
    ) {
      const radioTrack = await this.loadRadioQueue(this.state.currentTrack);
      if (radioTrack) {
        if (shouldResume) {
          await this.playTrackById(radioTrack.id);
        } else {
          await this.loadTrack(radioTrack);
        }
      }
      return;
    }
    logInternalInfo("PlayerController.skipToNext", {
      currentTrackId: this.state.currentTrack?.id ?? null,
      nextTrackId: nextTrack?.id ?? null,
    });
    if (!nextTrack || nextTrack.id === this.state.currentTrack?.id) return;
    if (shouldResume) {
      await this.playTrackById(nextTrack.id);
    } else {
      await this.loadTrack(nextTrack);
    }
  }

  private async handleTrackEnded(): Promise<void> {
    if (this.handlingTrackEnd || !this.isTabActive) return;
    this.handlingTrackEnd = true;

    try {
      if (this.playbackOrderMode === "repeat-one" && this.state.currentTrack) {
        await this.playTrackById(this.state.currentTrack.id);
        return;
      }

      let nextTrack: Track | null = null;
      if (this.playbackOrderMode === "shuffle") {
        nextTrack = this.queue.nextRandom();
      } else {
        nextTrack = this.queue.next(false);
      }

      if (nextTrack && nextTrack.id !== this.state.currentTrack?.id) {
        await this.playTrackById(nextTrack.id);
        return;
      }

      const seed = this.state.currentTrack;
      if (!this.autoplayEnabled || !seed || !this.dataSource.getRecommendations) {
        this.setState({ status: "paused" });
        return;
      }

      const recommendations = await this.getVariedRecommendations(seed);
      if (recommendations.length === 0) {
        this.setState({ status: "paused" });
        return;
      }

      this.queue.set(recommendations, 0);
      await this.playTrackById(recommendations[0].id);
    } catch (error) {
      this.setError(error);
    } finally {
      this.handlingTrackEnd = false;
    }
  }

  private async getVariedRecommendations(seed: Track): Promise<Track[]> {
    const recommendations = await this.dataSource.getRecommendations?.(seed) ?? [];
    const recentlySuggested = new Set(this.recommendationHistory.get(seed.id) ?? []);
    const recentlyPlayed = new Set(this.state.history.slice(-20).map((track) => track.id));
    const fresh = recommendations.filter(
      (track) => !recentlySuggested.has(track.id) && !recentlyPlayed.has(track.id),
    );
    const candidates = fresh.length >= 3
      ? fresh
      : recommendations.filter((track) => !recentlyPlayed.has(track.id));
    const shuffled = this.shuffle(candidates);
    const selected = shuffled.slice(0, 25);

    this.recommendationHistory.set(
      seed.id,
      [...selected.map((track) => track.id), ...recentlySuggested].slice(0, 50),
    );
    return selected;
  }

  private async primeRadioQueue(seed: Track, playRequestId: number): Promise<void> {
    const requestId = ++this.radioQueueRequestId;
    let recommendations: Track[];
    try {
      recommendations = await this.getVariedRecommendations(seed);
    } catch (error) {
      logInternalWarn("PlayerController.primeRadioQueue failed", {
        seedTrackId: seed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (
      requestId !== this.radioQueueRequestId
      || playRequestId !== this.playTrackRequestId
      || this.state.currentTrack?.id !== seed.id
      || recommendations.length === 0
    ) {
      return;
    }

    this.queue.replaceAutomaticUpcoming(recommendations);
  }

  private async loadRadioQueue(seed: Track): Promise<Track | null> {
    const requestId = ++this.radioQueueRequestId;
    let recommendations: Track[];
    try {
      recommendations = await this.getVariedRecommendations(seed);
    } catch (error) {
      logInternalWarn("PlayerController.loadRadioQueue failed", {
        seedTrackId: seed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (
      requestId !== this.radioQueueRequestId
      || this.state.currentTrack?.id !== seed.id
      || recommendations.length === 0
    ) {
      return null;
    }

    this.queue.set([seed, ...recommendations], 0);
    return this.queue.next(false);
  }

  private shuffle(tracks: Track[]): Track[] {
    const shuffled = [...tracks];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  private async ensureTrackLoaded(track: Track): Promise<void> {
    logInternalDebug("PlayerController.ensureTrackLoaded start", {
      trackId: track.id,
      loadedTrackId: this.loadedTrackId,
    });
    
    if (this.loadedTrackId === track.id) {
      logInternalDebug("PlayerController.ensureTrackLoaded already loaded", {
        trackId: track.id,
      });
      return;
    }

    try {
      const startedAt = performance.now();
      const audioData = this.audioEngine.usesNativeAudio()
        ? await this.dataSource.getStreamData?.(track)
        : undefined;
      if (this.audioEngine.usesNativeAudio() && !audioData) {
        throw new Error("The data source does not support native audio playback.");
      }
      await this.audioEngine.loadTrack(track.id, audioData?.bytes, audioData?.mimeType);

      this.loadedTrackId = track.id;
      if (this.pendingSeekTime !== null) {
        this.audioEngine.seekTo(this.pendingSeekTime);
        this.pendingSeekTime = null;
      }
      logInternalInfo("PlayerController.ensureTrackLoaded success", {
        trackId: track.id,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      logInternalError("PlayerController.ensureTrackLoaded failed", error, {
        trackId: track.id,
      });
      throw new Error("Unable to load audio data for playback.");
    }
  }

  private setState(partial: Partial<PlayerState>) {
    logInternalDebug("PlayerController.setState", {
      previousStatus: this.state.status,
      nextStatus: partial.status ?? this.state.status,
      hasError: Boolean(partial.error),
      trackId: partial.currentTrack?.id ?? this.state.currentTrack?.id ?? null,
    });
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private appendHistory(track: Track): Track[] {
    if (this.state.history[this.state.history.length - 1]?.id === track.id) {
      return this.state.history;
    }
    return [...this.state.history, track];
  }

  private setError(error: unknown) {
    logInternalError("PlayerController operation failed", error, {
      status: this.state.status,
      trackId: this.state.currentTrack?.id,
    });

    this.setState({
      status: "error",
      error: "Playback failed. Check internal logs for details.",
      // Preserve currentTrack to prevent reversion to hardcoded track
      currentTrack: this.state.currentTrack,
    });
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  async seekTo(time: number): Promise<void> {
    const seekTime = Math.max(0, time);
    logInternalInfo("PlayerController.seekTo", { time: seekTime, loadedTrackId: this.loadedTrackId, currentTrackId: this.state.currentTrack?.id });

    const currentTrack = this.state.currentTrack;
    if (!currentTrack) {
      logInternalWarn("PlayerController.seekTo no current track");
      return;
    }

    if (this.loadedTrackId !== currentTrack.id) {
      logInternalInfo("PlayerController.seekTo track not loaded, loading...", { trackId: currentTrack.id });
      this.pendingSeekTime = seekTime;
      try {
        await this.ensureTrackLoaded(currentTrack);
      } catch (error) {
        this.setError(error);
      }
      this.emit();
      return;
    }

    logInternalInfo("PlayerController.seekTo track already loaded, seeking...");
    this.audioEngine.seekTo(seekTime);
    this.emit();
  }

  async setVolume(level: number): Promise<void> {
    logInternalInfo("PlayerController.setVolume", { level });
    this.audioEngine.setVolume(level);
    this.emit();
  }

  async skipToPrevious(): Promise<void> {
    return this.queueNavigation(() => this.skipToPreviousNow());
  }

  private async skipToPreviousNow(): Promise<void> {
    const shouldResume = this.state.status === "playing";
    let previousTrack = this.queue.prev(false);
    if (!previousTrack || previousTrack.id === this.state.currentTrack?.id) {
      let currentHistoryIndex = -1;
      for (let index = this.state.history.length - 1; index >= 0; index -= 1) {
        if (this.state.history[index].id === this.state.currentTrack?.id) {
          currentHistoryIndex = index;
          break;
        }
      }
      previousTrack = currentHistoryIndex > 0
        ? this.state.history[currentHistoryIndex - 1]
        : null;
    }
    logInternalInfo("PlayerController.skipToPrevious", {
      currentTrackId: this.state.currentTrack?.id ?? null,
      previousTrackId: previousTrack?.id ?? null,
    });
    if (!previousTrack || previousTrack.id === this.state.currentTrack?.id) return;
    if (shouldResume) {
      await this.playTrackById(previousTrack.id);
    } else {
      await this.loadTrack(previousTrack);
    }
  }

  private queueNavigation(operation: () => Promise<void>): Promise<void> {
    const request = this.navigationRequest.then(operation, operation);
    this.navigationRequest = request.catch(() => undefined);
    return request;
  }

  suspendForTabSwitch(): void {
    this.isTabActive = false;
    if (this.state.status === "playing") {
      this.audioEngine.suspend();
    }
  }

  async resumeFromTabSwitch(): Promise<void> {
    this.isTabActive = true;
    if (this.state.status !== "playing" || !this.state.currentTrack) return;

    try {
      await this.ensureTrackLoaded(this.state.currentTrack);
      if (!this.isTabActive) return;
      const playbackStarted = await this.audioEngine.resume();
      if (!playbackStarted) return;
    } catch (error) {
      this.setError(error);
    }
  }

  dispose(): void {
    this.isTabActive = false;
    this.audioEngine.setOnEnded(null);
    this.audioEngine.dispose();
    this.listeners.clear();
  }

  getCurrentTime(): number {
    return this.audioEngine.getCurrentTime();
  }

  getPlayerSession(): PlayerSession {
    return this.exportSession();
  }

  getDuration(): number {
    return this.audioEngine.getDuration();
  }

  getVolume(): number {
    return this.audioEngine.getVolume();
  }

  isMuted(): boolean {
    return this.audioEngine.isMuted();
  }

  async toggleMute(): Promise<void> {
    const nextMuted = !this.audioEngine.isMuted();
    logInternalInfo("PlayerController.toggleMute", { muted: nextMuted });
    this.audioEngine.setMuted(nextMuted);
    this.emit();
  }

  async getLyrics(track: Track): Promise<Lyrics | null> {
    return this.dataSource.getLyrics?.(track) ?? null;
  }
}
