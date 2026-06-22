import { ClientType, Innertube, Platform, Types } from "youtubei.js";
import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../../internal/logging";
import { DataSource, type StreamData } from "../DataSource";
import type { Track } from "../types";
import { selectArtworkUrl } from "./artwork";
import { tauriFetch } from "./tauriFetch";

type MaybeInfo = {
  basic_info?: {
    id?: string;
    title?: string;
    author?: string;
    duration?: number;
    thumbnail?: Array<{ url?: string }>;
  };
  streaming_data?: {
    adaptive_formats?: Array<{ url?: string; has_audio?: boolean; mime_type?: string }>;
    formats?: Array<{ url?: string; has_audio?: boolean; mime_type?: string }>;
  };
  chooseFormat?: (
    options: { type: "audio"; quality: "best" | "best_audio" },
  ) => unknown;
};

function summarizeFormat(format: unknown): Record<string, unknown> {
  const item = format as {
    itag?: number;
    mime_type?: string;
    bitrate?: number;
    content_length?: string | number;
    audio_channels?: number;
    audio_sample_rate?: string | number;
    audio_quality?: string;
    approx_duration_ms?: string | number;
    url?: string;
    signature_cipher?: string;
    cipher?: string;
  } | null;

  return {
    itag: item?.itag ?? null,
    mimeType: item?.mime_type ?? null,
    bitrate: item?.bitrate ?? null,
    contentLength: item?.content_length ?? null,
    audioChannels: item?.audio_channels ?? null,
    audioSampleRate: item?.audio_sample_rate ?? null,
    audioQuality: item?.audio_quality ?? null,
    approxDurationMs: item?.approx_duration_ms ?? null,
    hasUrl: Boolean(item?.url),
    hasSignatureCipher: Boolean(item?.signature_cipher),
    hasCipher: Boolean(item?.cipher),
  };
}

function summarizeMediaUrl(url: string | null | undefined): Record<string, unknown> {
  if (!url) {
    return { present: false };
  }
  try {
    const parsed = new URL(url);
    return {
      present: true,
      origin: parsed.origin,
      path: parsed.pathname,
      hasQuery: parsed.search.length > 0,
      length: url.length,
    };
  } catch {
    return {
      present: true,
      invalid: true,
      length: url.length,
    };
  }
}

export class YouTubeDataSource extends DataSource {
  private ytPromise: Promise<Innertube> | null = null;
  private ytWebPromise: Promise<Innertube> | null = null;
  private ytTvPromise: Promise<Innertube> | null = null;
  private ytAndroidPromise: Promise<Innertube> | null = null;

  constructor() {
    super();
    this.setupJavaScriptEvaluator();
  }

  private setupJavaScriptEvaluator() {
    try {
      logInternalInfo("YouTubeDataSource.setupJavaScriptEvaluator initializing");
      
      Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
        logInternalDebug("YouTubeDataSource.javascript_evaluator called", {
          hasData: !!data.output,
          envKeys: Object.keys(env),
          outputLength: data.output?.length || 0,
        });
        
        const properties: string[] = [];
        
        if (env.n) {
          properties.push(`n: exportedVars.nFunction("${env.n}")`);
        }
        
        if (env.sig) {
          properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
        }
        
        const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
        const result = new Function(code)();
        
        logInternalDebug("YouTubeDataSource.javascript_evaluator result", {
          resultType: typeof result,
          hasResult: !!result,
          resultKeys: result ? Object.keys(result) : [],
        });
        
        return result;
      };
      
      logInternalInfo("YouTubeDataSource.setupJavaScriptEvaluator success");
    } catch (error) {
      logInternalError("YouTubeDataSource.setupJavaScriptEvaluator failed", error);
    }
  }

  private getCommonSessionOptions() {
    // Create a debug fetch wrapper to log everything
    const debugFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';
      const headers = init?.headers || {};
      
      logInternalInfo("YOUTUBE API REQUEST", {
        request: summarizeMediaUrl(url),
        method: method,
        headerCount: headers instanceof Headers
          ? Array.from(headers.keys()).length
          : Array.isArray(headers)
            ? headers.length
            : Object.keys(headers as Record<string, unknown>).length,
        hasBody: Boolean(init?.body),
        mode: init?.mode,
        credentials: init?.credentials,
        cache: init?.cache,
        redirect: init?.redirect,
        referrer: init?.referrer,
        referrerPolicy: init?.referrerPolicy,
        hasIntegrity: Boolean(init?.integrity),
        hasSignal: Boolean(init?.signal),
        timestamp: new Date().toISOString(),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        hasCookies: typeof document !== "undefined" && document.cookie.length > 0,
      });
      
      const startTime = Date.now();
      
      try {
        const response = await tauriFetch(input, init);
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        
        logInternalInfo("YOUTUBE API RESPONSE", {
          request: summarizeMediaUrl(url),
          method: method,
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headerKeys: Array.from(response.headers.keys()),
          type: response.type,
          response: summarizeMediaUrl(response.url),
          redirected: response.redirected,
          responseTime: responseTime,
          timestamp: new Date().toISOString(),
        });
        
        return response;
      } catch (error) {
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        
        logInternalError("YOUTUBE API ERROR", error as Error, {
          request: summarizeMediaUrl(url),
          method: method,
          hasHeaders: Boolean(headers),
          responseTime: responseTime,
          timestamp: new Date().toISOString(),
        });
        
        throw error;
      }
    };
    
    return {
      fetch: debugFetch,
      // Use native fetch for YouTube.js internal HTTP client to avoid proxy for audio downloads
      fetch_function: typeof window !== 'undefined' ? window.fetch.bind(window) : undefined,
      // Use the embedded WebView UA when available (Tauri dev/prod).
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      // Add session options for authentication-bound requests
      cookie: typeof document !== "undefined" ? document.cookie : undefined,
      // Enable player retrieval for better compatibility
      retrieve_player: true,
      // Add PO token support for better authentication
      po_token: undefined, // Can be set if we obtain a PO token
      // Add session context for better stream access
      generate_session_locally: true,
    } as const;
  }

  private getClient(): Promise<Innertube> {
    if (!this.ytPromise) {
      logInternalInfo("YouTubeDataSource.getClient creating client");
      this.ytPromise = Innertube.create({
        ...this.getCommonSessionOptions(),
        // Prefer the Music client: it tends to yield more reliable audio-only formats
        // and avoids some WEB-only playability edge cases.
        client_type: ClientType.MUSIC,
      });
    }
    logInternalDebug("YouTubeDataSource.getClient returning cached client");
    return this.ytPromise;
  }

  private getWebClient(): Promise<Innertube> {
    if (!this.ytWebPromise) {
      logInternalInfo("YouTubeDataSource.getWebClient creating client");
      this.ytWebPromise = Innertube.create({
        ...this.getCommonSessionOptions(),
        client_type: ClientType.WEB,
      });
    }
    return this.ytWebPromise;
  }

  private getTvClient(): Promise<Innertube> {
    if (!this.ytTvPromise) {
      logInternalInfo("YouTubeDataSource.getTvClient creating client");
      this.ytTvPromise = Innertube.create({
        ...this.getCommonSessionOptions(),
        client_type: ClientType.TV,
      });
    }
    return this.ytTvPromise;
  }

  private getAndroidClient(): Promise<Innertube> {
    if (!this.ytAndroidPromise) {
      logInternalInfo("YouTubeDataSource.getAndroidClient creating client");
      this.ytAndroidPromise = Innertube.create({
        ...this.getCommonSessionOptions(),
        client_type: ClientType.ANDROID,
      });
    }
    return this.ytAndroidPromise;
  }

  private async tryGetStreamingUrl(
    yt: Innertube,
    trackId: string,
    clientLabel: "music" | "web" | "tv" | "android",
  ): Promise<string | null> {
    try {
      logInternalInfo("YouTubeDataSource.tryGetStreamingUrl starting API call", {
        trackId,
        client: clientLabel,
      });
      
      const format = await yt.getStreamingData(trackId, { type: "audio", quality: "best" });
      
      logInternalInfo("YouTubeDataSource.tryGetStreamingUrl response", {
        trackId,
        client: clientLabel,
        responseType: typeof format,
        responseKeys: Object.keys(format),
        responseConstructor: format?.constructor?.name,
        format: summarizeFormat(format),
      });
      
      const player = yt.session.player;
      
      logInternalInfo("YouTubeDataSource.tryGetStreamingUrl PLAYER STATE", {
        trackId,
        client: clientLabel,
        hasPlayer: !!player,
        playerType: typeof player,
        playerKeys: player ? Object.keys(player) : [],
      });
      
      const decipheredUrl = await format.decipher(player);
      
      if (!decipheredUrl) {
        const f = format as unknown as {
          itag?: number;
          url?: string;
          mime_type?: string;
          signature_cipher?: string;
          cipher?: string;
        };
        logInternalWarn("YouTubeDataSource.getStreamUrl streamingData decipher empty", {
          trackId,
          client: clientLabel,
          hasPlayer: Boolean(player),
          itag: f.itag ?? null,
          hasUrl: Boolean(f.url),
          hasSignatureCipher: Boolean(f.signature_cipher),
          hasCipher: Boolean(f.cipher),
          mimeType: f.mime_type ?? null,
        });
        return null;
      }

      logInternalInfo("YouTubeDataSource.getStreamUrl streamingData selected", {
        trackId,
        client: clientLabel,
        itag: (format as { itag?: number }).itag,
        hasPlayer: Boolean(player),
      });
      return decipheredUrl;
    } catch (error) {
      logInternalError("YouTubeDataSource.tryGetStreamingUrl failed", error, {
        trackId,
        client: clientLabel,
      });
      return null;
    }
  }

  async getTrack(id: string): Promise<Track> {
    const trackId = id;
    if (!trackId) throw new Error("A track id is required.");
    logInternalInfo("YouTubeDataSource.getTrack start", { trackId });
    try {
      const yt = await this.getClient();
      const info = (await yt.getBasicInfo(trackId)) as unknown as MaybeInfo;
      const basic = info.basic_info;
      const artwork = selectArtworkUrl(basic?.thumbnail);

      return {
        id: basic?.id ?? trackId,
        source: "youtube",
        title: basic?.title ?? "Unknown title",
        artist: basic?.author ?? "Unknown artist",
        durationSec: basic?.duration,
        artworkUrl: artwork,
      };
    } catch (error) {
      // Keep "Load Track" resilient; playback may still succeed via getStreamUrl later.
      logInternalError("YouTubeDataSource.getTrack failed", error, { trackId });
      logInternalWarn("YouTubeDataSource.getTrack using fallback metadata", { trackId });
      return {
        id: trackId,
        source: "youtube",
        title: `Track (${trackId})`,
        artist: "Unknown artist",
      };
    }
  }

  async getStreamUrl(track: Track): Promise<string> {
    logInternalInfo("YouTubeDataSource.getStreamUrl start", { trackId: track.id });
    const failures: Array<{ step: string; client: "music" | "web" | "tv" | "android"; error: unknown }> = [];
    const yt = await this.getClient();

    try {
      const url = await this.tryGetStreamingUrl(yt, track.id, "music");
      if (url) {
        logInternalInfo("YouTubeDataSource.getStreamUrl success with music client", {
          trackId: track.id,
          mediaUrl: summarizeMediaUrl(url),
          client: "music",
        });
        return url;
      }
    } catch (error) {
      failures.push({ step: "getStreamingData", client: "music", error });
      logInternalWarn("YouTubeDataSource.getStreamUrl streamingData failed, falling back", {
        trackId: track.id,
        client: "music",
        error,
      });
    }

    let ytWeb: Innertube | null = null;
    try {
      ytWeb = await this.getWebClient();
      const url = await this.tryGetStreamingUrl(ytWeb, track.id, "web");
      if (url) {
        logInternalInfo("YouTubeDataSource.getStreamUrl success with web client", {
          trackId: track.id,
          mediaUrl: summarizeMediaUrl(url),
          client: "web",
        });
        return url;
      }
    } catch (error) {
      failures.push({ step: "getStreamingData", client: "web", error });
      logInternalWarn("YouTubeDataSource.getStreamUrl streamingData failed, falling back", {
        trackId: track.id,
        client: "web",
        error,
      });
    }

    // Try TV client as additional fallback
    let ytTv: Innertube | null = null;
    try {
      ytTv = await this.getTvClient();
      const url = await this.tryGetStreamingUrl(ytTv, track.id, "tv");
      if (url) {
        logInternalInfo("YouTubeDataSource.getStreamUrl success with tv client", {
          trackId: track.id,
          mediaUrl: summarizeMediaUrl(url),
          client: "tv",
        });
        return url;
      }
    } catch (error) {
      failures.push({ step: "getStreamingData", client: "tv", error });
      logInternalWarn("YouTubeDataSource.getStreamUrl streamingData failed, falling back", {
        trackId: track.id,
        client: "tv",
        error,
      });
    }

    // Try Android client as final fallback
    let ytAndroid: Innertube | null = null;
    try {
      ytAndroid = await this.getAndroidClient();
      const url = await this.tryGetStreamingUrl(ytAndroid, track.id, "android");
      if (url) {
        logInternalInfo("YouTubeDataSource.getStreamUrl success with android client", {
          trackId: track.id,
          mediaUrl: summarizeMediaUrl(url),
          client: "android",
        });
        return url;
      }
    } catch (error) {
      failures.push({ step: "getStreamingData", client: "android", error });
      logInternalWarn("YouTubeDataSource.getStreamUrl streamingData failed, falling back", {
        trackId: track.id,
        client: "android",
        error,
      });
    }

    // Fallback: WEB VideoInfo parsing + chooseFormat can sometimes succeed when `getStreamingData()`
    // fails to pick a valid decipherable format (e.g. "No valid URL to decipher").
    if (ytWeb) {
      try {
        const info = await ytWeb.getInfo(track.id);
        const format = info.chooseFormat({ type: "audio", quality: "best" });
        const url = await format.decipher(ytWeb.session.player);
        if (url) {
          logInternalInfo("YouTubeDataSource.getStreamUrl web chooseFormat selected", {
            trackId: track.id,
            mediaUrl: summarizeMediaUrl(url),
            itag: (format as unknown as { itag?: number }).itag ?? null,
            hasPlayer: Boolean(ytWeb.session.player),
            client: "web-chooseFormat",
          });
          return url;
        }
      } catch (error) {
        failures.push({ step: "getInfo.chooseFormat", client: "web", error });
        logInternalWarn("YouTubeDataSource.getStreamUrl web chooseFormat failed", {
          trackId: track.id,
          error,
        });
      }
    }

    // NOTE:
    // We intentionally avoid `yt.getInfo()` here. With the MUSIC client, youtubei.js may attempt
    // to parse WatchNext layouts that differ from the regular YouTube client and throw
    // (e.g. SingleColumnMusicWatchNextResults casting errors). `getStreamingData()` is the
    // supported way to fetch decipherable streaming formats without WatchNext parsing.

    logInternalError("YouTubeDataSource.getStreamUrl no playable format", new Error("Stream URL resolution failed"), {
      trackId: track.id,
      failures,
    });
    throw new Error("Unable to resolve audio stream URL from YouTube response.");
  }

  async getStreamData(track: Track): Promise<StreamData> {
    logInternalInfo("YouTubeDataSource.getStreamData start", { trackId: track.id });
    
    const clients = [
      { name: "music", getClient: () => this.getClient() },
      { name: "web", getClient: () => this.getWebClient() },
      { name: "tv", getClient: () => this.getTvClient() },
      { name: "android", getClient: () => this.getAndroidClient() },
    ];
    
    const errors: Array<{ client: string, error: unknown }> = [];
    
    for (const { name, getClient } of clients) {
      try {
        logInternalInfo(`YouTubeDataSource.getStreamData trying ${name} client`, { trackId: track.id });
        const yt = await getClient();
        
        const result = await this.tryDownloadWithClient(yt, track, name);
        logInternalInfo(`YouTubeDataSource.getStreamData success with ${name} client`, { trackId: track.id });
        return { bytes: result };
      } catch (error: any) {
        errors.push({ client: name, error });
        logInternalWarn(`YouTubeDataSource.getStreamData ${name} client failed`, {
          trackId: track.id,
          error: error?.message || String(error),
        });
        
        // If it's not a 403, don't try other clients (it's probably a genuine error)
        const errorMessage = error?.message || String(error);
        if (!errorMessage.includes('403') && !errorMessage.includes('Forbidden')) {
          throw error;
        }
      }
    }
    
    // All clients failed with 403
    logInternalError("YouTubeDataSource.getStreamData all clients failed with 403", new Error("All client types returned 403"), {
      trackId: track.id,
      errors: errors.map(e => ({ client: e.client, error: (e.error as any)?.message || String(e.error) })),
    });
    
    throw new Error("YouTube stream access denied (403). All client types failed. The video may be region-restricted or requires authentication.");
  }
  
  private async tryDownloadWithClient(yt: Innertube, track: Track, clientLabel: string): Promise<ArrayBuffer> {
      
      logInternalInfo("YouTubeDataSource.getStreamData using client", {
        trackId: track.id,
        clientType: yt.constructor.name,
        sessionExists: !!yt.session,
        sessionKeys: yt.session ? Object.keys(yt.session) : [],
      });
      
      // Use getBasicInfo() for all clients to avoid layout parsing errors with MUSIC client
      const apiMethod = "getBasicInfo";
      logInternalInfo(`YOUTUBE.JS API CALL - ${apiMethod}() - STARTING`, {
        trackId: track.id,
        clientLabel: clientLabel,
        clientType: yt.constructor.name,
        timestamp: new Date().toISOString(),
      });
      
      const startTime = Date.now();
      const info = await yt.getBasicInfo(track.id);
      const endTime = Date.now();
      const apiCallTime = endTime - startTime;

      // AD DETECTION: Check if video duration is suspiciously short (likely an ad)
      const basicInfo = (info as any).basic_info;
      const videoDuration = basicInfo?.duration || 0;
      const AD_DURATION_THRESHOLD = 60; // Ads are typically < 60 seconds
      
      if (videoDuration > 0 && videoDuration < AD_DURATION_THRESHOLD) {
        logInternalWarn("YouTubeDataSource.getStreamData DETECTED SHORT DURATION - LIKELY AD, SKIPPING", {
          trackId: track.id,
          clientLabel: clientLabel,
          videoDuration: videoDuration,
          threshold: AD_DURATION_THRESHOLD,
          isLikelyAd: true,
        });
        throw new Error(`Detected short duration video (${videoDuration}s), likely an ad. Skipping.`);
      }

      logInternalInfo("YouTubeDataSource.getStreamData AD CHECK PASSED", {
        trackId: track.id,
        clientLabel: clientLabel,
        videoDuration: videoDuration,
        isLikelyAd: false,
      });
      
      logInternalInfo(`YOUTUBE.JS API CALL - ${apiMethod}() - COMPLETE RESPONSE`, {
        trackId: track.id,
        clientLabel: clientLabel,
        clientType: yt.constructor.name,
        apiCallTime: apiCallTime,
        timestamp: new Date().toISOString(),
        infoType: typeof info,
        infoConstructor: info.constructor.name,
        infoKeys: Object.keys(info),
        infoDetails: {
          hasBasicInfo: !!(info as any).basic_info,
          hasStreamingData: !!(info as any).streaming_data,
          basicInfoKeys: (info as any).basic_info ? Object.keys((info as any).basic_info) : [],
          streamingDataKeys: (info as any).streaming_data ? Object.keys((info as any).streaming_data) : [],
          adaptiveFormatsCount: (info as any).streaming_data?.adaptive_formats?.length || 0,
          formatsCount: (info as any).streaming_data?.formats?.length || 0,
          videoId: (info as any).basic_info?.id,
          title: (info as any).basic_info?.title,
          duration: (info as any).basic_info?.duration,
        }
      });
      
      // Use YouTube.js built-in format selection which handles cipher and URL resolution
      logInternalInfo(`YOUTUBE.JS CHOOSEFORMAT() - STARTING`, {
        trackId: track.id,
        clientLabel: clientLabel,
        clientType: yt.constructor.name,
      });
      
      let format: any = null;
      
      try {
        // Use YouTube.js built-in format selection
        format = (info as any).chooseFormat({ type: "audio", quality: "best" });
        
        logInternalInfo(`YOUTUBE.JS CHOOSEFORMAT() - SUCCESS`, {
          trackId: track.id,
          clientLabel: clientLabel,
          chosenFormat: summarizeFormat(format),
          hasUrl: !!format?.url,
          hasCipher: !!(format?.signature_cipher || format?.cipher),
        });
      } catch (chooseFormatError: any) {
        logInternalWarn(`YOUTUBE.JS CHOOSEFORMAT() - FAILED, TRYING MANUAL SELECTION`, {
          trackId: track.id,
          clientLabel: clientLabel,
          error: chooseFormatError?.message || String(chooseFormatError),
        });
        
        // Fallback to manual selection
        const streamingData = (info as any).streaming_data;
        const adaptiveFormats = streamingData?.adaptive_formats || [];
        
        const audioFormats = adaptiveFormats.filter((f: any) => 
          f.mime_type?.includes('audio')
        );
        
        if (audioFormats.length > 0) {
          audioFormats.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
          format = audioFormats[0];
          
          logInternalInfo(`MANUAL FORMAT SELECTION FALLBACK - FORMAT CHOSEN`, {
            trackId: track.id,
            clientLabel: clientLabel,
            chosenFormat: summarizeFormat(format),
            hasUrl: !!format?.url,
            hasCipher: !!(format?.signature_cipher || format?.cipher),
          });
        }
      }
      
      if (!format) {
        logInternalError(`NO AUDIO FORMAT FOUND - ALL METHODS FAILED`, new Error("No audio formats found"), {
          trackId: track.id,
          clientLabel: clientLabel,
        });
        throw new Error("No audio formats found");
      }
      
      logInternalInfo("YOUTUBE.JS API CALL - FORMAT SELECTED FROM getBasicInfo()", {
        trackId: track.id,
        clientLabel: clientLabel,
        clientType: yt.constructor.name,
        timestamp: new Date().toISOString(),
        formatType: typeof format,
        formatConstructor: format?.constructor?.name,
        formatKeys: Object.keys(format),
        formatDetails: summarizeFormat(format),
      });
      
      const player = yt.session.player;
      
      logInternalInfo("YouTubeDataSource.getStreamData COMPLETE PLAYER STATE", {
        trackId: track.id,
        clientLabel: clientLabel,
        hasPlayer: !!player,
        playerType: typeof player,
        playerConstructor: player?.constructor?.name,
        playerKeys: player ? Object.keys(player) : [],
      });
      
      // Check format for direct URL or cipher before attempting deciphering
      const formatAny = format as any;
      let directUrl: string | null = null;
      let hasCipher = false;
      
      if (formatAny.url) {
        directUrl = formatAny.url;
        logInternalInfo("YouTubeDataSource.getStreamData FOUND DIRECT URL - USING DIRECTLY", {
          trackId: track.id,
          clientLabel: clientLabel,
          mediaUrl: summarizeMediaUrl(directUrl),
          bypassDeciphering: true,
        });
        
        // Use direct URL without deciphering
        const decipheredUrl = directUrl;
        
        logInternalInfo("YouTubeDataSource.getStreamData DECIPHERED URL COMPLETE", {
          trackId: track.id,
          clientLabel: clientLabel,
          mediaUrl: summarizeMediaUrl(decipheredUrl),
          urlType: typeof decipheredUrl,
          urlContainsSignature: decipheredUrl?.includes('signature') || decipheredUrl?.includes('sig'),
          urlContainsIp: decipheredUrl?.match(/\d+\.\d+\.\d+\.\d+/) ? true : false,
          urlProtocol: decipheredUrl?.startsWith('https://') ? 'https' : decipheredUrl?.startsWith('http://') ? 'http' : 'other',
          urlDomain: decipheredUrl?.match(/https?:\/\/([^\/]+)/)?.[1] || 'unknown',
          isDirectUrl: true,
          bypassedDeciphering: true,
        });
        
        // Continue with download using direct URL
        return this.continueWithDownload(decipheredUrl!, track, clientLabel, yt);
      }
      
      if (formatAny.signature_cipher || formatAny.cipher) {
        hasCipher = true;
        logInternalInfo("FOUND SIGNATURE CIPHER - ATTEMPTING DECIPHER", {
          trackId: track.id,
          clientLabel: clientLabel,
          hasSignatureCipher: Boolean(formatAny.signature_cipher),
          hasCipher: Boolean(formatAny.cipher),
        });
      }
      
      // Only attempt deciphering if we don't have a direct URL
      let decipheredUrl: string | null = null;
      
      try {
        decipheredUrl = await format.decipher(player);
        logInternalInfo("YouTubeDataSource.getStreamData DECIPHER SUCCESS", {
          trackId: track.id,
          clientLabel: clientLabel,
          mediaUrl: summarizeMediaUrl(decipheredUrl),
        });
      } catch (decipherError: any) {
        logInternalError("YouTubeDataSource.getStreamData DECIPHER FAILED", decipherError, {
          trackId: track.id,
          clientLabel: clientLabel,
          errorMessage: decipherError?.message || String(decipherError),
          hasDirectUrl: !!directUrl,
          hasCipher: hasCipher,
        });
        
        // Fallback to direct URL if available
        if (directUrl) {
          logInternalInfo("YouTubeDataSource.getStreamData FALLBACK TO DIRECT URL", {
            trackId: track.id,
            clientLabel: clientLabel,
            mediaUrl: summarizeMediaUrl(directUrl),
          });
          decipheredUrl = directUrl;
        } else {
          throw new Error(`Deciphering failed for ${clientLabel} client: ${decipherError?.message || String(decipherError)}`);
        }
      }
      
      // Continue with download using deciphered URL
      return this.continueWithDownload(decipheredUrl!, track, clientLabel, yt);
  }
  
  private async continueWithDownload(
    decipheredUrl: string, 
    track: Track, 
    clientLabel: string, 
    yt: Innertube
  ): Promise<ArrayBuffer> {
    const trackId = track.id;
    
    try {
      logInternalInfo("YouTubeDataSource.getStreamData starting download", {
        trackId,
        clientLabel,
        mediaUrl: summarizeMediaUrl(decipheredUrl),
      });
      
      // Use YouTube.js's internal fetch which handles authentication properly
      const response = await yt.session.http.fetch(decipheredUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      
      logInternalInfo("YouTubeDataSource.getStreamData download success", {
        trackId,
        clientLabel,
        byteLength: arrayBuffer.byteLength,
      });
      
      return arrayBuffer;
    } catch (error: any) {
      // Check if this is a 403 Forbidden error
      const errorMessage = error?.message || String(error);
      const is403Error = errorMessage.includes('403') || errorMessage.includes('Forbidden');
      
      logInternalError("YouTubeDataSource.getStreamData download failed", error, { 
        trackId,
        clientLabel,
        is403Error,
        errorMessage,
      });
      
      if (is403Error) {
        throw new Error("YouTube stream access denied (403). The video may be region-restricted or requires authentication.");
      }
      
      throw new Error("Unable to download audio stream from YouTube.");
    }
  }
}
