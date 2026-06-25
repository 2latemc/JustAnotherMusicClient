import { logInternalError, logInternalInfo } from "../internal/logging";

type YouTubePlayerEvent = {
  data: number;
};

type YouTubePlayer = {
  cueVideoById(videoId: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  destroy(): void;
};

type YouTubePlayerConstructor = new (
  element: HTMLElement,
  options: {
    width: number;
    height: number;
    videoId?: string;
    playerVars: Record<string, number | string>;
    events: {
      onReady: () => void;
      onStateChange: (event: YouTubePlayerEvent) => void;
      onError: (event: YouTubePlayerEvent) => void;
    };
  },
) => YouTubePlayer;

declare global {
  interface Window {
    YT?: {
      Player: YouTubePlayerConstructor;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let iframeApiPromise: Promise<void> | null = null;
const audioEngines = new Set<AudioEngine>();
let playbackClaimId = 0;
let playbackOwner: AudioEngine | null = null;

function shouldUseNativeAudio(): boolean {
  // The maintained playback path is the YouTube iframe player. Native audio is
  // kept as an explicit fallback for player errors that are specific to a webview.
  return false;
}

function detectAudioMimeType(bytes: Uint8Array): string {
  if (
    bytes.length >= 4
    && bytes[0] === 0x1a
    && bytes[1] === 0x45
    && bytes[2] === 0xdf
    && bytes[3] === 0xa3
  ) {
    return "audio/webm";
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
  ) {
    return "audio/mp4";
  }
  return "audio/mp4";
}

function loadYouTubeIframeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (iframeApiPromise) return iframeApiPromise;

  iframeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("Unable to load the YouTube player API."));
    document.head.appendChild(script);
  });

  return iframeApiPromise;
}

export class AudioEngine {
  private readonly useNativeAudio = shouldUseNativeAudio();
  private player: YouTubePlayer | null = null;
  private playerPromise: Promise<YouTubePlayer> | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioObjectUrl: string | null = null;
  private currentVideoId: string | null = null;
  private volume = 1;
  private muted = false;
  private onEnded: (() => void) | null = null;
  private loadRequestId = 0;
  private stateWaiters = new Set<{
    states: Set<number>;
    videoId: string | null;
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>();

  constructor() {
    audioEngines.add(this);
  }

  usesNativeAudio(): boolean {
    return this.useNativeAudio;
  }

  async loadTrack(videoId: string, audioData?: ArrayBuffer, mimeType?: string): Promise<void> {
    if (this.useNativeAudio) {
      if (!audioData) {
        throw new Error("Native playback requires downloaded audio data.");
      }
      await this.loadNativeAudio(videoId, audioData, mimeType);
      return;
    }

    const requestId = ++this.loadRequestId;
    this.releaseNativeAudio();
    const player = await this.ensurePlayer();
    if (requestId !== this.loadRequestId) return;
    if (this.currentVideoId === videoId) return;

    this.currentVideoId = videoId;
    // A previous track may already have left the player in CUED. Wait for the
    // state event from this cue request instead of accepting that stale state.
    const cued = this.waitForPlayerState(
      [window.YT!.PlayerState.CUED],
      15_000,
      false,
      videoId,
    );
    player.cueVideoById(videoId);
    try {
      await cued;
    } catch (error) {
      if (requestId === this.loadRequestId && this.currentVideoId === videoId) {
        this.currentVideoId = null;
      }
      throw error;
    }
    if (requestId !== this.loadRequestId || this.currentVideoId !== videoId) return;
    logInternalInfo("AudioEngine.loadTrack cued", { videoId });
  }

  async loadNativeFallback(
    videoId: string,
    audioData: ArrayBuffer,
    mimeType?: string,
  ): Promise<void> {
    this.player?.stopVideo();
    await this.loadNativeAudio(videoId, audioData, mimeType);
  }

  setOnEnded(listener: (() => void) | null): void {
    this.onEnded = listener;
  }

  async play(): Promise<boolean> {
    const claimId = this.claimPlayback();
    if (this.useNativeAudio || this.audio) {
      if (!this.audio || !this.currentVideoId) {
        throw new Error("No audio track is loaded.");
      }
      this.applyNativeAudioSettings();
      await this.audio.play();
      return claimId === playbackClaimId && playbackOwner === this;
    }

    const player = await this.ensurePlayer();
    if (claimId !== playbackClaimId || playbackOwner !== this) {
      player.pauseVideo();
      return false;
    }
    if (!this.currentVideoId) {
      throw new Error("No YouTube track is loaded.");
    }

    if (this.muted) {
      player.mute();
    } else {
      player.unMute();
    }
    player.setVolume(Math.round(this.volume * 100));
    const playing = this.waitForPlayerState(
      [window.YT!.PlayerState.PLAYING],
      15_000,
      true,
      this.currentVideoId,
    );
    player.playVideo();
    await playing;
    if (claimId !== playbackClaimId || playbackOwner !== this) {
      player.pauseVideo();
      return false;
    }
    logInternalInfo("AudioEngine.play requested", {
      videoId: this.currentVideoId,
      muted: this.muted,
      volume: this.volume,
    });
    return true;
  }

  pause(): void {
    this.audio?.pause();
    this.player?.pauseVideo();
  }

  suspend(): void {
    this.pause();
  }

  async resume(): Promise<boolean> {
    if (this.currentVideoId) {
      return this.play();
    }
    return false;
  }

  stop(): void {
    this.loadRequestId += 1;
    if (playbackOwner === this) {
      playbackOwner = null;
      playbackClaimId += 1;
    }
    this.releaseNativeAudio();
    this.player?.stopVideo();
    this.currentVideoId = null;
    this.rejectStateWaiters(new Error("Playback was stopped."));
  }

  silenceCompetingPlayback(): void {
    this.claimPlayback();
  }

  dispose(): void {
    this.stop();
    this.player?.destroy();
    this.player = null;
    audioEngines.delete(this);
  }

  seekTo(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    if (this.audio) {
      this.audio.currentTime = Math.min(
        Math.max(0, seconds),
        Number.isFinite(this.audio.duration) ? this.audio.duration : seconds,
      );
    }
    this.player?.seekTo(Math.max(0, seconds), true);
  }

  setVolume(level: number): void {
    this.volume = Math.min(1, Math.max(0, level));
    if (this.audio) this.audio.volume = this.volume;
    this.player?.setVolume(Math.round(this.volume * 100));
  }

  getVolume(): number {
    if (this.audio) return this.audio.volume;
    return this.player ? this.player.getVolume() / 100 : this.volume;
  }

  setMuted(isMuted: boolean): void {
    this.muted = isMuted;
    if (this.audio) this.audio.muted = isMuted;
    if (isMuted) {
      this.player?.mute();
    } else {
      this.player?.unMute();
    }
  }

  isMuted(): boolean {
    if (this.audio) return this.audio.muted;
    return this.player?.isMuted() ?? this.muted;
  }

  getCurrentTime(): number {
    if (this.audio) return this.audio.currentTime;
    return this.player?.getCurrentTime() ?? 0;
  }

  getDuration(): number {
    if (this.audio) return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    return this.player?.getDuration() ?? 0;
  }

  private async loadNativeAudio(
    videoId: string,
    audioData: ArrayBuffer,
    mimeType?: string,
  ): Promise<void> {
    const requestId = ++this.loadRequestId;
    this.releaseNativeAudio();

    const bytes = new Uint8Array(audioData);
    const blob = new Blob([bytes], { type: mimeType || detectAudioMimeType(bytes) });
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = objectUrl;
    audio.addEventListener("ended", () => this.onEnded?.());
    audio.addEventListener("error", () => {
      logInternalError(
        "AudioEngine native audio error",
        new Error(`Native audio failed with media error ${audio.error?.code ?? "unknown"}.`),
        { videoId },
      );
    });
    this.audio = audio;
    this.audioObjectUrl = objectUrl;
    this.currentVideoId = videoId;
    this.applyNativeAudioSettings();

    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while loading native audio."));
      }, 30_000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        audio.removeEventListener("canplay", handleReady);
        audio.removeEventListener("error", handleError);
      };
      const handleReady = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`Unable to decode native audio (${audio.error?.code ?? "unknown"}).`));
      };
      audio.addEventListener("canplay", handleReady, { once: true });
      audio.addEventListener("error", handleError, { once: true });
      audio.load();
    });

    if (requestId !== this.loadRequestId) return;
    logInternalInfo("AudioEngine native audio loaded", {
      videoId,
      byteLength: audioData.byteLength,
      mimeType: blob.type,
    });
  }

  private applyNativeAudioSettings(): void {
    if (!this.audio) return;
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;
  }

  private releaseNativeAudio(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = null;
    }
  }

  private async ensurePlayer(): Promise<YouTubePlayer> {
    if (this.player) return this.player;
    if (this.playerPromise) return this.playerPromise;

    this.playerPromise = this.createPlayer();
    try {
      this.player = await this.playerPromise;
      return this.player;
    } finally {
      this.playerPromise = null;
    }
  }

  private claimPlayback(): number {
    const claimId = ++playbackClaimId;
    playbackOwner = this;

    for (const engine of audioEngines) {
      if (engine !== this) engine.pauseForPlaybackClaim();
    }
    for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
      media.pause();
    }

    return claimId;
  }

  private pauseForPlaybackClaim(): void {
    this.audio?.pause();
    this.player?.pauseVideo();
  }

  private async createPlayer(): Promise<YouTubePlayer> {
    await loadYouTubeIframeApi();
    if (!window.YT?.Player) {
      throw new Error("YouTube player API loaded without a Player constructor.");
    }

    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-10000px";
    host.style.top = "0";
    host.style.width = "200px";
    host.style.height = "200px";
    host.style.pointerEvents = "none";
    document.body.appendChild(host);

    return new Promise((resolve, reject) => {
      let player: YouTubePlayer;
      const timeoutId = window.setTimeout(() => {
        player?.destroy();
        host.remove();
        reject(new Error("Timed out while creating the YouTube player."));
      }, 15_000);

      player = new window.YT!.Player(host, {
        width: 200,
        height: 200,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
          widget_referrer: `${window.location.origin}/`,
        },
        events: {
          onReady: () => {
            window.clearTimeout(timeoutId);
            player.setVolume(Math.round(this.volume * 100));
            player.unMute();
            logInternalInfo("AudioEngine YouTube player ready");
            resolve(player);
          },
          onStateChange: (event) => {
            logInternalInfo("AudioEngine YouTube player state", {
              state: event.data,
              videoId: this.currentVideoId,
              playerVideoId: player.getVideoData().video_id ?? null,
            });
            this.resolveStateWaiters(event.data, player.getVideoData().video_id ?? null);
            if (event.data === window.YT!.PlayerState.ENDED) {
              this.onEnded?.();
            }
          },
          onError: (event) => {
            const error = new Error(`YouTube player error ${event.data}`);
            this.rejectStateWaiters(error);
            logInternalError("AudioEngine YouTube player error", error, {
              videoId: this.currentVideoId,
            });
          },
        },
      });
    });
  }

  private waitForPlayerState(
    states: number[],
    timeoutMs: number,
    acceptCurrentState = true,
    videoId: string | null = null,
  ): Promise<void> {
    if (acceptCurrentState) {
      const currentState = this.player?.getPlayerState();
      const currentVideoId = this.player?.getVideoData().video_id ?? null;
      if (
        currentState !== undefined
        && states.includes(currentState)
        && (!videoId || currentVideoId === videoId)
      ) {
        return Promise.resolve();
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        states: new Set(states),
        videoId,
        resolve,
        reject,
        timeoutId: 0,
      };

      waiter.timeoutId = window.setTimeout(() => {
        this.stateWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for YouTube player state: ${states.join(", ")}.`));
      }, timeoutMs);

      this.stateWaiters.add(waiter);
    });
  }

  private resolveStateWaiters(state: number, videoId: string | null): void {
    for (const waiter of this.stateWaiters) {
      if (
        !waiter.states.has(state)
        || (waiter.videoId !== null && waiter.videoId !== videoId)
      ) {
        continue;
      }
      window.clearTimeout(waiter.timeoutId);
      this.stateWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectStateWaiters(error: Error): void {
    for (const waiter of this.stateWaiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(error);
    }
    this.stateWaiters.clear();
  }
}
