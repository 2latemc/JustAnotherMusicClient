import { invoke } from "@tauri-apps/api/core";
import { ClientType, Innertube, Platform, Types, YTNodes } from "youtubei.js";
import { clearCache, getCachedJson, setCachedJson } from "../../internal/cache";
import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../../internal/logging";
import { DataSource, type StreamData } from "../DataSource";
import type {
  Album,
  Artist,
  ArtistPage,
  ArtistReference,
  AuthPrompt,
  LibrarySnapshot,
  Lyrics,
  Playlist,
  SearchResults,
  Track,
} from "../types";
import { collectArtworkCandidates, getVideoArtworkFallback, selectArtworkUrl } from "./artwork";
import { tauriFetch } from "./tauriFetch";

type ClientLabel = "music" | "web";
type NativeAudioPayload = {
  bodyBase64: string;
  mimeType: string;
};

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type MusicItem = {
  id?: string;
  title?: string | { toString(): string };
  item_type?: string;
  menu?: unknown;
  artists?: Array<{ name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } }>;
  authors?: Array<{ name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } }>;
  author?: { name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } };
  subtitle?: {
    toString(): string;
    runs?: Array<{ text?: string; endpoint?: { payload?: { browseId?: string } } }>;
  };
  thumbnail?: Array<{ url?: string; width?: number; height?: number }>
    | { contents?: Array<{ url?: string; width?: number; height?: number }> }
    | null;
  thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
  endpoint?: {
    payload?: {
      browseId?: string;
      videoId?: string;
    };
  };
  views?: string;
  subscribers?: string;
  year?: string;
  fixed_columns?: Array<{
    title?: { toString(): string; runs?: Array<{ text?: string }> };
  }>;
  flex_columns?: Array<{
    title?: { toString(): string; runs?: Array<{ text?: string }> };
  }>;
};

type ParsedMusicResponse = {
  contents_memo?: {
    getType(...types: unknown[]): MusicItem[];
    entries(): IterableIterator<[string, unknown[]]>;
  };
  continuation_contents_memo?: {
    getType(...types: unknown[]): MusicItem[];
    entries(): IterableIterator<[string, unknown[]]>;
  };
};

type MusicContinuation = {
  key: string;
  load(): Promise<unknown>;
};

type UpNextItem = {
  video_id?: string;
  title?: { toString(): string };
  author?: string;
  artists?: Array<{ name?: string }>;
  thumbnail?: Array<{ url?: string; width?: number; height?: number }>;
  duration?: { seconds?: number };
  primary?: UpNextItem | null;
};

type LrcLibTrack = {
  duration?: number;
  syncedLyrics?: string | null;
};

type RawLikeEndpoint = {
  status?: string;
  target?: string;
  params?: string;
  likeParams?: string;
  removeLikeParams?: string;
};

type CallableEndpoint = {
  call(actions: Innertube["actions"], args?: Record<string, unknown>): Promise<{
    success?: boolean;
    status_code?: number;
  }>;
  payload?: unknown;
};

type LibraryToggleEndpoint = {
  isToggled?: boolean;
  endpoint?: CallableEndpoint;
  toggledEndpoint?: CallableEndpoint;
  iconType?: string;
  tooltip?: string;
  toggledTooltip?: string;
};

type RawServiceEndpoint = {
  commandExecutorCommand?: {
    commands?: RawServiceEndpoint[];
  };
  feedbackEndpoint?: {
    feedbackToken?: string;
    cpn?: string;
    isFeedbackTokenUnencrypted?: boolean;
    shouldMerge?: boolean;
  };
  likeEndpoint?: RawLikeEndpoint;
};

type RawToggleButtonRenderer = {
  isToggled?: boolean;
  defaultIcon?: { iconType?: string };
  defaultTooltip?: string;
  toggledTooltip?: string;
  defaultServiceEndpoint?: RawServiceEndpoint;
  toggledServiceEndpoint?: RawServiceEndpoint;
};

type AccountCandidate = {
  accountIndex: number;
  name?: string;
  onBehalfOfUser?: string;
  serializedDelegationContext?: string;
  selected?: boolean;
};

type LibraryResponses = {
  client: Innertube;
  account: AccountCandidate;
  libraryLanding: unknown;
  historyResponse: unknown;
};

const LIKED_SONGS_PLAYLIST_ID = "LM";
const LIBRARY_CACHE_KEY = "youtube-music:library:v5";

export class YouTubeMusicDataSource extends DataSource {
  private musicClientPromise: Promise<Innertube> | null = null;
  private webClientPromise: Promise<Innertube> | null = null;
  private musicCookie: string | null = null;
  private musicAccountIndex = 0;
  private musicOnBehalfOfUser: string | null = null;
  private musicSerializedDelegationContext: string | null = null;
  private musicAccountName = "YouTube Music";
  private libraryRefreshPromise: Promise<LibrarySnapshot> | null = null;
  private readonly albumRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly playlistRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly trackRefreshPromises = new Map<string, Promise<Track>>();
  private readonly searchRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly mixedSearchRefreshPromises = new Map<string, Promise<SearchResults>>();
  private readonly artistRefreshPromises = new Map<string, Promise<ArtistPage>>();
  private readonly suggestionRefreshPromises = new Map<string, Promise<string[]>>();
  private readonly recommendationRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly lyricsRefreshPromises = new Map<string, Promise<Lyrics | null>>();

  constructor() {
    super();
    this.setupJavaScriptEvaluator();
  }

  private setupJavaScriptEvaluator() {
    Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
      logInternalDebug("YouTubeMusicDataSource.javascriptEvaluator", {
        envKeys: Object.keys(env),
        outputLength: data.output?.length ?? 0,
      });

      return new Function(data.output)();
    };
  }

  private getSessionOptions() {
    return {
      fetch: tauriFetch,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      cookie: this.musicCookie ?? (typeof document !== "undefined" ? document.cookie : undefined),
      account_index: this.musicAccountIndex,
      on_behalf_of_user: this.musicOnBehalfOfUser ?? undefined,
      retrieve_player: true,
      generate_session_locally: true,
    } as const;
  }

  private getMusicClient(): Promise<Innertube> {
    if (!this.musicClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getMusicClient creating client");
      this.musicClientPromise = Innertube.create({
          ...this.getSessionOptions(),
          client_type: ClientType.MUSIC,
        })
        .then(async (client) => {
          await this.refreshMusicClientMetadata(client);
          this.applyDelegationContext(client);
          return client;
        });
    }

    return this.musicClientPromise;
  }

  private getWebClient(): Promise<Innertube> {
    if (!this.webClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getWebClient creating client");
      this.webClientPromise = Innertube.create({
        ...this.getSessionOptions(),
        client_type: ClientType.WEB,
      });
    }

    return this.webClientPromise;
  }

  private async getClient(label: ClientLabel): Promise<Innertube> {
    return label === "music" ? this.getMusicClient() : this.getWebClient();
  }

  private async refreshMusicClientMetadata(client: Innertube): Promise<void> {
    try {
      const response = await tauriFetch("https://music.youtube.com/", {
        headers: {
          Accept: "text/html",
        },
      });
      if (!response.ok) {
        throw new Error(`YouTube Music bootstrap returned HTTP ${response.status}.`);
      }

      const html = await response.text();
      const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
      const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];

      if (!clientVersion) {
        throw new Error("YouTube Music bootstrap did not contain a client version.");
      }

      client.session.context.client.clientVersion = clientVersion;
      client.session.context.client.originalUrl = "https://music.youtube.com";
      if (client.session.context.client.mainAppWebInfo) {
        client.session.context.client.mainAppWebInfo.graftUrl = "https://music.youtube.com";
      }
      delete client.session.context.client.configInfo;
      if (apiKey) client.session.api_key = apiKey;

      logInternalInfo("YouTubeMusicDataSource.refreshMusicClientMetadata success", {
        clientVersion,
      });
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.refreshMusicClientMetadata failed", {
        error: error instanceof Error ? error.message : String(error),
        fallbackVersion: client.session.context.client.clientVersion,
      });
    }
  }

  private applyDelegationContext(client: Innertube): void {
    if (!this.musicSerializedDelegationContext) return;
    const session = client.session as {
      context: {
        user: {
          serializedDelegationContext?: string;
        };
      };
    };
    session.context.user.serializedDelegationContext = this.musicSerializedDelegationContext;
  }

  private resetMusicSessionSelection(): void {
    this.musicAccountIndex = 0;
    this.musicOnBehalfOfUser = null;
    this.musicSerializedDelegationContext = null;
    this.musicAccountName = "YouTube Music";
    this.musicClientPromise = null;
    this.webClientPromise = null;
  }

  private getArtwork(item: MusicItem): string | undefined {
    return selectArtworkUrl(collectArtworkCandidates(item.thumbnail, item.thumbnails));
  }

  private getArtistName(item: MusicItem): string {
    return item.artists?.map((artist) => artist.name).filter(Boolean).join(", ")
      || item.authors?.map((author) => author.name).filter(Boolean).join(", ")
      || item.author?.name
      || item.subtitle?.runs
        ?.filter((run) => run.endpoint?.payload?.browseId?.startsWith("UC"))
        .map((run) => run.text)
        .filter(Boolean)
        .join(", ")
      || item.subtitle?.toString()
      || "Unknown artist";
  }

  private getArtists(item: MusicItem): ArtistReference[] | undefined {
    const toArtistReference = (value: unknown) => {
      const candidate = value as {
        name?: string;
        text?: string;
        channel_id?: string;
        endpoint?: unknown;
        navigationEndpoint?: unknown;
      };
      return {
        id: candidate.channel_id
          ?? this.findBrowseId(candidate.endpoint)
          ?? this.findBrowseId(candidate.navigationEndpoint)
          ?? "",
        name: candidate.name ?? candidate.text ?? "",
      };
    };
    const candidates = item.artists?.length
      ? item.artists
      : item.authors?.length
        ? item.authors
        : item.author
          ? [item.author]
          : [];
    const artists = candidates
      .map(toArtistReference)
      .filter((artist) => artist.id.startsWith("UC") && artist.name);

    if (artists.length > 0) return artists;

    const runs = item.subtitle?.runs ?? [];
    const fromRuns = runs
      .map(toArtistReference)
      .filter((artist) => artist.id.startsWith("UC") && artist.name);
    return fromRuns.length > 0 ? fromRuns : undefined;
  }

  private findBrowseId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        browseId?: unknown;
        payload?: unknown;
      };
      if (typeof candidate.browseId === "string") return candidate.browseId;
      const payloadBrowseId = visit(candidate.payload);
      if (payloadBrowseId) return payloadBrowseId;

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findStringByKey(root: unknown, keys: Set<string>): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      for (const [key, child] of Object.entries(value)) {
        if (keys.has(key) && typeof child === "string" && child.length > 0) {
          return child;
        }
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findYoutubeChannelId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      for (const child of Object.values(value)) {
        if (typeof child === "string" && /^UC[\w-]{20,}$/.test(child)) {
          return child;
        }
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private parseViewCount(value?: string): number | undefined {
    if (!value) return undefined;
    const match = value.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;
    const multiplier = match[2]?.toUpperCase() === "B"
      ? 1_000_000_000
      : match[2]?.toUpperCase() === "M"
        ? 1_000_000
        : match[2]?.toUpperCase() === "K"
          ? 1_000
          : 1;
    return Math.round(amount * multiplier);
  }

  private getViewCountText(item: MusicItem): string | undefined {
    if (item.views) return item.views;
    const texts = [
      ...(item.fixed_columns ?? []).flatMap((column) => [
        column.title?.toString(),
        ...(column.title?.runs?.map((run) => run.text) ?? []),
      ]),
      ...(item.flex_columns ?? []).flatMap((column) => [
        column.title?.toString(),
        ...(column.title?.runs?.map((run) => run.text) ?? []),
      ]),
      item.subtitle?.toString(),
      ...(item.subtitle?.runs?.map((run) => run.text) ?? []),
    ].filter((value): value is string => Boolean(value));
    return texts.find((value) => /\bviews?\b|\bplays?\b/i.test(value))
      ?? texts.find((value) => /^\s*\d+(?:[.,]\d+)?\s*[KMB]\s*$/i.test(value));
  }

  private getTitle(item: MusicItem): string | null {
    if (typeof item.title === "string") return item.title;
    const title = item.title?.toString();
    return title || null;
  }

  private getPlaylistItemId(item: MusicItem): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object" || seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        action?: unknown;
        setVideoId?: unknown;
      };
      if (
        candidate.action === "ACTION_REMOVE_VIDEO"
        && typeof candidate.setVideoId === "string"
      ) {
        return candidate.setVideoId;
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(item.menu);
  }

  private toAlbum(item: MusicItem): Album | null {
    const id = item.id ?? this.findBrowseId(item.endpoint);
    const title = this.getTitle(item);
    if (!id || !title) return null;

    return {
      id,
      title,
      artist: this.getArtistName(item),
      artists: this.getArtists(item),
      artworkUrl: this.getArtwork(item),
    };
  }

  private toPlaylist(item: MusicItem): Playlist | null {
    const id = item.id ?? this.findBrowseId(item.endpoint);
    const title = this.getTitle(item);
    if (!id || !title) return null;

    const owner = this.getArtistName(item);
    return {
      id,
      title,
      owner: owner === "Unknown artist" ? "YouTube Music playlist" : owner,
      artworkUrl: this.getArtwork(item),
      isSaved: false,
    };
  }

  private toTrack(item: MusicItem): Track | null {
    const id = item.id ?? item.endpoint?.payload?.videoId;
    const title = this.getTitle(item);
    if (!id || !title) return null;
    const viewCountText = this.getViewCountText(item);

    return {
      id,
      source: "youtube",
      title,
      artist: this.getArtistName(item),
      artists: this.getArtists(item),
      artworkUrl: this.getArtwork(item) ?? getVideoArtworkFallback(id),
      playlistItemId: this.getPlaylistItemId(item),
      viewCount: this.parseViewCount(viewCountText),
      viewCountText,
    };
  }

  private toArtist(item: MusicItem): Artist | null {
    const id = item.id ?? this.findBrowseId(item.endpoint);
    const name = this.getTitle(item) ?? item.author?.name ?? item.artists?.[0]?.name;
    if (!id?.startsWith("UC") || !name) return null;
    return {
      id,
      name,
      artworkUrl: this.getArtwork(item),
      subscriberCount: item.subscribers,
    };
  }

  private collectMusicItems(root: unknown, acceptedTypes: Set<string>): MusicItem[] {
    const results: MusicItem[] = [];
    const seen = new WeakSet<object>();
    const response = root as ParsedMusicResponse;
    const nodeTypes = [YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem];

    for (const memo of [response.contents_memo, response.continuation_contents_memo]) {
      if (!memo) continue;
      for (const item of memo.getType(...nodeTypes)) {
        if (item.item_type && acceptedTypes.has(item.item_type) && this.getTitle(item)) {
          results.push(item);
        }
      }
    }

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      const item = value as MusicItem;
      if (item.item_type && acceptedTypes.has(item.item_type) && this.getTitle(item)) {
        results.push(item);
      }

      for (const child of Object.values(value)) {
        visit(child);
      }
    };

    visit(root);
    return results;
  }

  private uniqueById<T extends { id: string }>(items: T[]): T[] {
    return [...new Map(items.map((item) => [item.id, item])).values()];
  }

  private findLikeEndpoint(root: unknown, status: "LIKE" | "INDIFFERENT"): RawLikeEndpoint | null {
    const seen = new WeakSet<object>();
    let match: RawLikeEndpoint | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { likeEndpoint?: RawLikeEndpoint };
      if (candidate.likeEndpoint?.status === status) {
        match = candidate.likeEndpoint;
        return;
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    return match;
  }

  private findLibraryToggleEndpoint(root: unknown): LibraryToggleEndpoint | null {
    const seen = new WeakSet<object>();
    let fallback: LibraryToggleEndpoint | null = null;
    let match: LibraryToggleEndpoint | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as {
        type?: string;
        is_toggled?: boolean;
        endpoint?: CallableEndpoint;
        toggled_endpoint?: CallableEndpoint;
        icon_type?: string;
        tooltip?: string;
        toggled_tooltip?: string;
      };
      if (
        candidate.type === "ToggleButton"
        && candidate.endpoint
        && candidate.toggled_endpoint
        && candidate.icon_type !== "LIKE"
        && candidate.icon_type !== "DISLIKE"
      ) {
        const toggle = {
          isToggled: candidate.is_toggled,
          endpoint: candidate.endpoint,
          toggledEndpoint: candidate.toggled_endpoint,
          iconType: candidate.icon_type,
          tooltip: candidate.tooltip,
          toggledTooltip: candidate.toggled_tooltip,
        };
        const text = `${candidate.tooltip ?? ""} ${candidate.toggled_tooltip ?? ""}`.toLocaleLowerCase();
        if (text.includes("library") || text.includes("save")) {
          match = toggle;
          return;
        }
        fallback ??= toggle;
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    return match ?? fallback;
  }

  private findRawLibraryToggle(root: unknown): RawToggleButtonRenderer | null {
    const seen = new WeakSet<object>();
    let fallback: RawToggleButtonRenderer | null = null;
    let match: RawToggleButtonRenderer | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { toggleButtonRenderer?: RawToggleButtonRenderer };
      const toggle = candidate.toggleButtonRenderer;
      if (toggle) {
        const iconType = toggle.defaultIcon?.iconType;
        if (iconType !== "LIKE" && iconType !== "DISLIKE") {
          const hasDefaultEndpoint = Boolean(toggle.defaultServiceEndpoint);
          const hasToggledEndpoint = Boolean(toggle.toggledServiceEndpoint);
          const hasEndpoints = hasDefaultEndpoint || hasToggledEndpoint;

          if (hasEndpoints) {
            const text = `${toggle.defaultTooltip ?? ""} ${toggle.toggledTooltip ?? ""}`.toLocaleLowerCase();
            if (text.includes("library") || text.includes("save")) {
              match = toggle;
              return;
            }
            fallback ??= toggle;
          }
        }
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    const result: RawToggleButtonRenderer | null = match ?? fallback;
    if (result) {
      logInternalInfo("YouTubeMusicDataSource.findRawLibraryToggle found toggle", {
        source: match ? "tooltip" : "fallback",
        iconType: result.defaultIcon?.iconType,
        defaultTooltip: result.defaultTooltip,
        toggledTooltip: result.toggledTooltip,
      });
    } else {
      logInternalWarn("YouTubeMusicDataSource.findRawLibraryToggle no toggle found");
    }
    return result;
  }

  private findArtistSubscriptionToggle(root: unknown): { subscribed: boolean } | null {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): { subscribed: boolean } | null => {
      if (!value || typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);

      const candidate = value as {
        subscribeButtonRenderer?: {
          subscribed?: boolean;
          channelId?: string;
          notificationPreferenceButton?: unknown;
          targetId?: string;
        };
      };
      const renderer = candidate.subscribeButtonRenderer;
      if (renderer) {
        return { subscribed: Boolean(renderer.subscribed) };
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };

    return visit(root);
  }

  private getActionableServiceEndpoint(endpoint: RawServiceEndpoint): RawServiceEndpoint {
    const commands = endpoint.commandExecutorCommand?.commands;
    if (!commands?.length) return endpoint;
    return commands.find((command) => command.feedbackEndpoint || command.likeEndpoint)
      ?? commands[commands.length - 1]
      ?? endpoint;
  }

  private async executeRawServiceEndpoint(
    client: Innertube,
    endpoint: RawServiceEndpoint,
  ): Promise<{ success?: boolean; status_code?: number }> {
    const command = this.getActionableServiceEndpoint(endpoint);
    if (command.feedbackEndpoint?.feedbackToken) {
      const feedback = command.feedbackEndpoint;
      return client.actions.execute("/feedback", {
        feedbackTokens: [feedback.feedbackToken],
        ...(feedback.cpn ? { feedbackContext: { cpn: feedback.cpn } } : {}),
        isFeedbackTokenUnencrypted: Boolean(feedback.isFeedbackTokenUnencrypted),
        shouldMerge: Boolean(feedback.shouldMerge),
      });
    }
    if (command.likeEndpoint) {
      const like = command.likeEndpoint;
      const params = like.status === "LIKE"
        ? like.likeParams ?? like.params
        : like.removeLikeParams ?? like.params;
      return client.actions.execute(
        like.status === "LIKE" ? "/like/like" : "/like/removelike",
        {
          client: "YTMUSIC",
          target: like.target,
          ...(params ? { params } : {}),
        },
      );
    }
    throw new Error("YouTube Music returned an unsupported album library command.");
  }

  private async executeTrackLikeCommand(
    musicClient: Innertube,
    trackId: string,
    liked: boolean,
  ) {
    const musicNextResponse = await musicClient.actions.execute("/next", {
      videoId: trackId,
      client: "YTMUSIC",
    });
    const status = liked ? "LIKE" : "INDIFFERENT";
    let endpoint = this.findLikeEndpoint(musicNextResponse.data, status);
    let endpointSource = "music";

    if (!endpoint?.target) {
      const webClient = await this.getWebClient();
      const webNextResponse = await webClient.actions.execute("/next", {
        videoId: trackId,
      });
      endpoint = this.findLikeEndpoint(webNextResponse.data, status);
      endpointSource = "web";
    }

    if (!endpoint?.target) {
      logInternalError("YouTubeMusicDataSource.executeTrackLikeCommand missing endpoint", {
        trackId,
        status,
      });
      throw new Error(`YouTube did not return a ${status} command for this song.`);
    }

    const params = liked
      ? endpoint.likeParams ?? endpoint.params
      : endpoint.removeLikeParams ?? endpoint.params;
    const path = liked ? "/like/like" : "/like/removelike";

    logInternalInfo("YouTubeMusicDataSource.executeTrackLikeCommand", {
      trackId,
      status,
      hasParams: Boolean(params),
      endpointSource,
    });

    return musicClient.actions.execute(path, {
      client: "YTMUSIC",
      target: endpoint.target,
      ...(params ? { params } : {}),
    });
  }

  private getMusicContinuation(client: Innertube, root: unknown): MusicContinuation | null {
    const seen = new WeakSet<object>();
    const found: {
      endpoint: {
        payload?: { continuation?: string };
        call(actions: Innertube["actions"], args: { client: string; parse: true }): Promise<unknown>;
      } | null;
    } = {
      endpoint: null,
    };
    let tokenContinuation: string | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || found.endpoint) return;
      if (seen.has(value)) return;
      seen.add(value);

      if (value instanceof YTNodes.ContinuationItem) {
        found.endpoint = value.endpoint as {
      payload?: { continuation?: string };
      call(actions: Innertube["actions"], args: { client: string; parse: true }): Promise<unknown>;
        };
        return;
      }

      const candidate = value as {
        continuation?: unknown;
        contents?: unknown;
      };
      if (
        !tokenContinuation
        && typeof candidate.continuation === "string"
        && candidate.continuation
        && candidate.contents
      ) {
        tokenContinuation = candidate.continuation;
      }

      for (const child of Object.values(value)) {
        visit(child);
      }
    };

    visit(root);

    if (found.endpoint) {
      const endpoint = found.endpoint;
      const key = endpoint.payload?.continuation || `endpoint:${JSON.stringify(endpoint.payload ?? {})}`;
      return {
        key,
        load: () => endpoint.call(client.actions, { client: "YTMUSIC", parse: true }),
      };
    }

    if (tokenContinuation) {
      const continuation = tokenContinuation;
      return {
        key: continuation,
        load: () => this.executeMusicBrowse(client, {
          client: "YTMUSIC",
          continuation,
        }),
      };
    }

    return null;
  }

  private async collectAllTracks(client: Innertube, initialResponse: unknown): Promise<Track[]> {
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();
    let response = initialResponse;
    let pageCount = 0;

    while (true) {
      items.push(...this.collectMusicItems(response, new Set(["song", "video"])));
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, response);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectAllTracks repeated continuation", {
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      response = await continuation.load();
    }

    const tracks = this.uniqueById(
      items.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)),
    );
    logInternalInfo("YouTubeMusicDataSource.collectAllTracks complete", {
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private async collectPlaylistTracks(client: Innertube, playlistId: string): Promise<Track[]> {
    const items: MusicItem[] = [];
    const seenPages = new Set<string>();
    let page = await client.music.getPlaylist(playlistId);
    let pageCount = 0;

    while (true) {
      const pageItems = page.items
        .filterType(YTNodes.MusicResponsiveListItem)
        .filter((item) => item.item_type === "song" || item.item_type === "video");
      items.push(...pageItems as unknown as MusicItem[]);
      pageCount += 1;

      const pageKey = pageItems
        .map((item) => item.id)
        .filter(Boolean)
        .join(",");
      if (seenPages.has(pageKey)) {
        logInternalWarn("YouTubeMusicDataSource.collectPlaylistTracks repeated page", {
          playlistId,
          pageCount,
        });
        break;
      }
      seenPages.add(pageKey);

      if (!page.has_continuation) break;
      page = await page.getContinuation();
    }

    const tracks = items
      .map((item) => this.toTrack(item))
      .filter((item): item is Track => Boolean(item));
    logInternalInfo("YouTubeMusicDataSource.collectPlaylistTracks complete", {
      playlistId,
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private getAlbumHeaderArtwork(response: unknown): string | undefined {
    const parsed = response as ParsedMusicResponse;
    const detailHeader = parsed.contents_memo?.getType(YTNodes.MusicDetailHeader)?.[0] as {
      thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      };
    } | undefined;
    const responsiveHeader = parsed.contents_memo?.getType(YTNodes.MusicResponsiveHeader)?.[0] as {
      thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      };
    } | undefined;

    return selectArtworkUrl(
      detailHeader?.thumbnails,
      detailHeader?.thumbnail?.contents,
      responsiveHeader?.thumbnails,
      responsiveHeader?.thumbnail?.contents,
    );
  }

  private async enrichMissingAlbumArtwork(client: Innertube, albums: Album[]): Promise<Album[]> {
    const missingAlbums = albums.filter((album) => !album.artworkUrl);
    if (missingAlbums.length === 0) return albums;

    logInternalInfo("YouTubeMusicDataSource.enrichMissingAlbumArtwork start", {
      missingCount: missingAlbums.length,
      albumIds: missingAlbums.map((album) => album.id),
    });

    const artworkByAlbumId = new Map<string, string>();
    const queue = [...missingAlbums];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length > 0) {
        const album = queue.shift();
        if (!album) return;

        try {
          const response = await this.executeMusicBrowse(client, { browseId: album.id });
          const artworkUrl = this.getAlbumHeaderArtwork(response);
          if (artworkUrl) artworkByAlbumId.set(album.id, artworkUrl);
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.enrichMissingAlbumArtwork album failed", {
            albumId: album.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    await Promise.all(workers);
    logInternalInfo("YouTubeMusicDataSource.enrichMissingAlbumArtwork complete", {
      missingCount: missingAlbums.length,
      resolvedCount: artworkByAlbumId.size,
    });

    return albums.map((album) => {
      const artworkUrl = artworkByAlbumId.get(album.id);
      return artworkUrl ? { ...album, artworkUrl } : album;
    });
  }

  private async getCreatedPlaylists(client: Innertube, playlistLibrary: unknown): Promise<Playlist[]> {
    const playlistItems = this.collectMusicItems(playlistLibrary, new Set(["playlist"]));
    const playlists = this.uniqueById(
      playlistItems
        .map((item) => this.toPlaylist(item))
        .filter((item): item is Playlist => Boolean(item))
        .filter((item) => {
          const normalizedId = item.id.replace(/^VL/, "").toUpperCase();
          if (normalizedId === "LM") return false;
          const lowerTitle = item.title.toLocaleLowerCase();
          if (lowerTitle === "liked songs" || lowerTitle === "likes" || lowerTitle.includes("new releases") || lowerTitle.includes("new episodes")) return false;
          return true;
        }),
    );
    const createdPlaylistIds = new Set<string>();
    const queue = [...playlists];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length > 0) {
        const playlist = queue.shift();
        if (!playlist) return;

        try {
          const response = await this.executeMusicBrowse(client, { browseId: playlist.id });
          const parsed = response as ParsedMusicResponse;
          const editableHeader = parsed.contents_memo
            ?.getType(YTNodes.MusicEditablePlaylistDetailHeader)?.[0] as {
              playlist_id?: string;
            } | undefined;
          if (!editableHeader) continue;

          createdPlaylistIds.add(playlist.id);
          if (!playlist.artworkUrl) {
            playlist.artworkUrl = this.getAlbumHeaderArtwork(response);
          }
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.getCreatedPlaylists playlist failed", {
            playlistId: playlist.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    await Promise.all(workers);
    return playlists.map((playlist) => ({
      ...playlist,
      isSaved: true,
      isEditable: createdPlaylistIds.has(playlist.id),
    }));
  }

  private async getLikedSongs(client: Innertube): Promise<{
    playlist: Playlist;
    tracks: Track[];
  }> {
    const tracks = await this.collectPlaylistTracks(client, LIKED_SONGS_PLAYLIST_ID);

    return {
      playlist: {
        id: LIKED_SONGS_PLAYLIST_ID,
        title: "Liked Songs",
        owner: "YouTube Music",
        kind: "liked-songs",
      },
      tracks,
    };
  }

  private async applyLibraryFilter(
    client: Innertube,
    response: unknown,
    filterName: string,
  ): Promise<unknown> {
    const parsed = response as ParsedMusicResponse;
    const chipCloud = parsed.contents_memo?.getType(YTNodes.ChipCloud)?.[0] as {
      chips?: Array<{
        text?: string;
        endpoint?: {
          call(actions: Innertube["actions"], args: { parse: true }): Promise<unknown>;
        };
      }>;
    } | undefined;
    const filter = chipCloud?.chips?.find((chip) => chip.text === filterName);
    if (!filter?.endpoint) {
      logInternalWarn("YouTubeMusicDataSource.applyLibraryFilter missing filter", {
        filterName,
        availableFilters: chipCloud?.chips?.map((chip) => chip.text).filter(Boolean) ?? [],
      });
      return response;
    }

    return filter.endpoint.call(client.actions, { parse: true });
  }

  private getRendererCounts(response: unknown): Record<string, number> {
    const parsed = response as ParsedMusicResponse;
    const counts: Record<string, number> = {};
    for (const memo of [parsed.contents_memo, parsed.continuation_contents_memo]) {
      if (!memo) continue;
      for (const [renderer, items] of memo.entries()) {
        counts[renderer] = (counts[renderer] ?? 0) + items.length;
      }
    }
    return counts;
  }

  private getResponseMessages(response: unknown): string[] {
    const parsed = response as ParsedMusicResponse;
    const messages: string[] = [];
    for (const memo of [parsed.contents_memo, parsed.continuation_contents_memo]) {
      if (!memo) continue;
      for (const message of memo.getType(YTNodes.Message) as Array<{ text?: { toString(): string } }>) {
        const text = message.text?.toString();
        if (text) messages.push(text);
      }
    }
    return messages;
  }

  private async executeMusicBrowse(client: Innertube, args: Record<string, unknown>): Promise<unknown> {
    return client.actions.execute("/browse", {
      ...args,
      parse: true,
    });
  }

  private async loadLibraryResponses(client: Innertube) {
    logInternalInfo("YouTubeMusicDataSource.loadLibraryResponses start", {
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
    });
    const [libraryLanding, historyResponse] = await Promise.all([
      this.executeMusicBrowse(client, { browseId: "FEmusic_library_landing" }),
      this.executeMusicBrowse(client, { browseId: "FEmusic_history" }),
    ]);
    logInternalInfo("YouTubeMusicDataSource.loadLibraryResponses complete", {
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
      libraryRenderers: this.getRendererCounts(libraryLanding),
      historyRenderers: this.getRendererCounts(historyResponse),
      libraryMessages: this.getResponseMessages(libraryLanding),
      historyMessages: this.getResponseMessages(historyResponse),
    });
    return { libraryLanding, historyResponse };
  }

  private getLibrarySignal(libraryLanding: unknown, historyResponse: unknown): number {
    const albumCount = this.collectMusicItems(libraryLanding, new Set(["album"])).length;
    const playlistCount = this.collectMusicItems(libraryLanding, new Set(["playlist"])).length;
    const recentCount = this.collectMusicItems(historyResponse, new Set(["song", "video"])).length;
    const messages = this.getResponseMessages(libraryLanding).length
      + this.getResponseMessages(historyResponse).length;
    return albumCount + playlistCount + recentCount - messages * 10;
  }

  private async getAccountCandidates(client: Innertube): Promise<AccountCandidate[]> {
    const fallback: AccountCandidate = { accountIndex: 0, name: "YouTube Music", selected: true };
    try {
      const accountItems = await client.account.getInfo(true) as Array<{
        account_name?: { toString(): string };
        account_byline?: { toString(): string };
        channel_handle?: { toString(): string };
        endpoint?: unknown;
        has_channel?: boolean;
        is_disabled?: boolean;
        is_selected?: boolean;
      }>;
      const candidates = accountItems
        .filter((item) => !item.is_disabled)
        .flatMap((item, index): AccountCandidate[] => {
          const endpoint = item.endpoint;
          const onBehalfOfUser = this.findBrowseId(endpoint)
            ?? this.findYoutubeChannelId(endpoint);
          const serializedDelegationContext = this.findStringByKey(
            endpoint,
            new Set(["selectedSerializedDelegationContext", "serializedDelegationContext"]),
          );
          const name = item.account_name?.toString()
            || item.channel_handle?.toString()
            || item.account_byline?.toString()
            || undefined;
          if (!onBehalfOfUser && !serializedDelegationContext && index === 0) {
            return [{ ...fallback, name, selected: item.is_selected }];
          }
          if (!onBehalfOfUser && !serializedDelegationContext) return [];
          return [{
            accountIndex: 0,
            name,
            onBehalfOfUser,
            serializedDelegationContext,
            selected: item.is_selected,
          }];
        });

      const unique = this.uniqueById(
        [fallback, ...candidates].map((candidate) => ({
          ...candidate,
          id: [
            candidate.accountIndex,
            candidate.onBehalfOfUser ?? "",
            candidate.serializedDelegationContext ?? "",
          ].join(":"),
        })),
      ).map(({ id: _id, ...candidate }) => candidate);

      logInternalInfo("YouTubeMusicDataSource.getAccountCandidates success", {
        candidateCount: unique.length,
        selectedCount: unique.filter((candidate) => candidate.selected).length,
        candidates: unique.map((candidate) => ({
          accountIndex: candidate.accountIndex,
          hasOnBehalfOfUser: Boolean(candidate.onBehalfOfUser),
          hasSerializedDelegationContext: Boolean(candidate.serializedDelegationContext),
          selected: candidate.selected,
          name: candidate.name,
        })),
      });
      return unique;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getAccountCandidates failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [fallback];
    }
  }

  private async useAccountCandidate(candidate: AccountCandidate): Promise<Innertube> {
    const changed = this.musicAccountIndex !== candidate.accountIndex
      || this.musicOnBehalfOfUser !== (candidate.onBehalfOfUser ?? null)
      || this.musicSerializedDelegationContext !== (candidate.serializedDelegationContext ?? null);
    this.musicAccountIndex = candidate.accountIndex;
    this.musicOnBehalfOfUser = candidate.onBehalfOfUser ?? null;
    this.musicSerializedDelegationContext = candidate.serializedDelegationContext ?? null;
    this.musicAccountName = candidate.name ?? "YouTube Music";
    if (changed) {
      this.musicClientPromise = null;
      this.webClientPromise = null;
    }
    return this.getMusicClient();
  }

  private async findBestLibraryResponses(initialClient: Innertube): Promise<LibraryResponses> {
    const fallback: AccountCandidate = {
      accountIndex: this.musicAccountIndex,
      name: this.musicAccountName,
      onBehalfOfUser: this.musicOnBehalfOfUser ?? undefined,
      serializedDelegationContext: this.musicSerializedDelegationContext ?? undefined,
      selected: true,
    };
    const initialResponses = await this.loadLibraryResponses(initialClient);
    let best: LibraryResponses = {
      client: initialClient,
      account: fallback,
      ...initialResponses,
    };
    let bestSignal = this.getLibrarySignal(best.libraryLanding, best.historyResponse);
    const profileCandidates = await this.getAccountCandidates(initialClient);
    const authUserCandidates: AccountCandidate[] = bestSignal <= 0
      ? [1, 2, 3, 4, 5].map((accountIndex) => ({
          accountIndex,
          name: `YouTube Music account ${accountIndex + 1}`,
        }))
      : [];
    const candidates = this.uniqueById(
      [...profileCandidates, ...authUserCandidates].map((candidate) => ({
        ...candidate,
        id: [
          candidate.accountIndex,
          candidate.onBehalfOfUser ?? "",
          candidate.serializedDelegationContext ?? "",
        ].join(":"),
      })),
    ).map(({ id: _id, ...candidate }) => candidate);

    for (const candidate of candidates) {
      const key = [
        candidate.accountIndex,
        candidate.onBehalfOfUser ?? "",
        candidate.serializedDelegationContext ?? "",
      ].join(":");
      const bestKey = [
        best.account.accountIndex,
        best.account.onBehalfOfUser ?? "",
        best.account.serializedDelegationContext ?? "",
      ].join(":");
      if (key === bestKey) continue;

      try {
        const client = await this.useAccountCandidate(candidate);
        const { libraryLanding, historyResponse } = await this.loadLibraryResponses(client);
        const signal = this.getLibrarySignal(libraryLanding, historyResponse);
        if (signal > bestSignal || (signal === bestSignal && candidate.selected && !best.account.selected)) {
          best = { client, account: candidate, libraryLanding, historyResponse };
          bestSignal = signal;
        }
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.findBestLibraryResponses candidate failed", {
          accountIndex: candidate.accountIndex,
          hasOnBehalfOfUser: Boolean(candidate.onBehalfOfUser),
          hasSerializedDelegationContext: Boolean(candidate.serializedDelegationContext),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.useAccountCandidate(best.account);
    logInternalInfo("YouTubeMusicDataSource.findBestLibraryResponses selected", {
      accountIndex: best.account.accountIndex,
      hasOnBehalfOfUser: Boolean(best.account.onBehalfOfUser),
      hasSerializedDelegationContext: Boolean(best.account.serializedDelegationContext),
      selected: best.account.selected,
      signal: bestSignal,
      name: best.account.name,
    });
    return best;
  }

  async restoreSession(): Promise<boolean> {
    logInternalInfo("YouTubeMusicDataSource.restoreSession start");
    try {
      this.musicCookie = await invoke<string | null>("load_youtube_music_cookie");
      if (!this.musicCookie) {
        logInternalInfo("YouTubeMusicDataSource.restoreSession no stored session");
        return false;
      }
      logInternalInfo("YouTubeMusicDataSource.restoreSession credential loaded", {
        credentialBytes: this.musicCookie.length,
      });
      this.resetMusicSessionSelection();
      await this.getMusicClient();
      logInternalInfo("YouTubeMusicDataSource.restoreSession success");
      return true;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.restoreSession failed", error);
      return false;
    }
  }

  async signIn(onPrompt: (prompt: AuthPrompt) => void): Promise<void> {
    logInternalInfo("YouTubeMusicDataSource.signIn start");
    onPrompt({
      verificationUrl: "https://music.youtube.com/",
      userCode: "Browser sign-in",
      expiresInSec: 300,
    });
    this.musicCookie = await invoke<string>("sign_in_youtube_music");
    try {
      await clearCache();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.signIn cache clear failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logInternalInfo("YouTubeMusicDataSource.signIn command completed", {
      credentialBytes: this.musicCookie.length,
    });
    this.resetMusicSessionSelection();
    await this.getMusicClient();
    logInternalInfo("YouTubeMusicDataSource.signIn success");
  }

  async signOut(): Promise<void> {
    logInternalInfo("YouTubeMusicDataSource.signOut start");
    await invoke("delete_youtube_music_cookie");
    await invoke("delete_youtube_credentials");
    try {
      await clearCache();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.signOut cache clear failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.musicCookie = null;
    this.resetMusicSessionSelection();
    logInternalInfo("YouTubeMusicDataSource.signOut success");
  }

  getCachedLibrary(): Promise<LibrarySnapshot | null> {
    return getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
  }

  async getLibrary(onUpdate?: (library: LibrarySnapshot) => void): Promise<LibrarySnapshot> {
    const cacheKey = LIBRARY_CACHE_KEY;
    const cached = await getCachedJson<LibrarySnapshot>(cacheKey);

    if (cached && this.hasLibraryContent(cached)) {
      globalThis.setTimeout(() => {
        void this.refreshLibrary(cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getLibrary background refresh failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getLibrary ignoring empty cache entry");
    }

    return (await this.refreshLibrary(cacheKey)).value;
  }

  private hasLibraryContent(library: LibrarySnapshot): boolean {
    return library.albums.length > 0
      || library.playlists.length > 0
      || library.likedSongs.length > 0
      || library.recentlyPlayed.length > 0;
  }

  private async refreshLibrary(cacheKey: string): Promise<{ changed: boolean; value: LibrarySnapshot }> {
    if (!this.libraryRefreshPromise) {
      this.libraryRefreshPromise = this.fetchLibraryFresh().finally(() => {
        this.libraryRefreshPromise = null;
      });
    }

    const value = await this.libraryRefreshPromise;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchLibraryFresh(): Promise<LibrarySnapshot> {
    logInternalInfo("YouTubeMusicDataSource.getLibrary start", {
      hasCookie: Boolean(this.musicCookie),
      accountIndex: this.musicAccountIndex,
    });
    if (!this.musicCookie) {
      throw new Error("Sign in is required to load the YouTube Music library.");
    }

    let client = await this.getMusicClient();
    const bestLibrary = await this.findBestLibraryResponses(client);
    client = bestLibrary.client;
    const { libraryLanding, historyResponse } = bestLibrary;
    const libraryMessages = this.getResponseMessages(libraryLanding);

    const [albumLibrary, playlistLibrary] = await Promise.all([
      this.applyLibraryFilter(client, libraryLanding, "Albums"),
      this.applyLibraryFilter(client, libraryLanding, "Playlists"),
    ]);

    const albumItems = this.collectMusicItems(albumLibrary, new Set(["album"]));
    const recentItems = this.collectMusicItems(historyResponse, new Set(["song", "video"]));
    const parsedAlbums = this.uniqueById(albumItems.map((item) => this.toAlbum(item)).filter((item): item is Album => Boolean(item)));
    const [albums, playlists, likedSongsResult] = await Promise.all([
      this.enrichMissingAlbumArtwork(client, parsedAlbums),
      this.getCreatedPlaylists(client, playlistLibrary),
      this.getLikedSongs(client),
    ]);
    const recentlyPlayed = this.uniqueById(recentItems.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)));
    const historyMessages = this.getResponseMessages(historyResponse);
    await setCachedJson(
      `youtube-music:playlist-tracks:v4:${LIKED_SONGS_PLAYLIST_ID}`,
      likedSongsResult.tracks,
    );

    if (libraryMessages.length > 0 && albums.length === 0) {
      throw new Error(`YouTube Music returned an account message: ${libraryMessages.join(" ")}`);
    }

    logInternalInfo("YouTubeMusicDataSource.getLibrary success", {
      albumCount: albums.length,
      playlistCount: playlists.length,
      likedSongCount: likedSongsResult.tracks.length,
      recentTrackCount: recentlyPlayed.length,
      albumRenderers: this.getRendererCounts(albumLibrary),
      playlistRenderers: this.getRendererCounts(playlistLibrary),
      historyRenderers: this.getRendererCounts(historyResponse),
      libraryMessages,
      historyMessages,
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
      accountName: this.musicAccountName,
    });

    return {
      account: {
        name: this.musicAccountName,
      },
      albums,
      playlists,
      likedSongsPlaylist: likedSongsResult.playlist,
      likedSongs: likedSongsResult.tracks,
      recentlyPlayed,
    };
  }

  async getAlbumTracks(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const cacheKey = `youtube-music:album-tracks:v3:${album.id}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached?.length) {
      globalThis.setTimeout(() => {
        void this.refreshAlbumTracks(album, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getAlbumTracks background refresh failed", {
              albumId: album.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getAlbumTracks ignoring empty cache entry", {
        albumId: album.id,
      });
    }

    return (await this.refreshAlbumTracks(album, cacheKey)).value;
  }

  async setAlbumSaved(album: Album, saved: boolean): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }
    try {
      const client = await this.getMusicClient();
      const albumResponse = await this.executeMusicBrowse(client, { browseId: album.id });
      const rawToggle = this.findRawLibraryToggle(albumResponse);

      if (rawToggle) {
        if (rawToggle.isToggled === saved) return;
        const endpoint = saved
          ? rawToggle.defaultServiceEndpoint
          : rawToggle.toggledServiceEndpoint;
        if (!endpoint) {
          throw new Error("YouTube Music returned an incomplete library command for this album.");
        }

        logInternalInfo("YouTubeMusicDataSource.setAlbumSaved raw command", {
          albumId: album.id,
          saved,
          iconType: rawToggle.defaultIcon?.iconType,
          defaultTooltip: rawToggle.defaultTooltip,
          toggledTooltip: rawToggle.toggledTooltip,
        });

        const response = await this.executeRawServiceEndpoint(client, endpoint);
        if (response.success === false) {
          throw new Error(`Album library update returned HTTP ${response.status_code}.`);
        }
        return;
      }

      const albumPage = await client.music.getAlbum(album.id);
      const toggle = this.findLibraryToggleEndpoint(albumPage.page);
      if (!toggle) {
        throw new Error("YouTube Music did not return a library command for this album.");
      }
      if (toggle.isToggled === saved) return;

      const endpoint = saved ? toggle.endpoint : toggle.toggledEndpoint;
      if (!endpoint) {
        throw new Error("YouTube Music returned an incomplete library command for this album.");
      }

      logInternalInfo("YouTubeMusicDataSource.setAlbumSaved command", {
        albumId: album.id,
        saved,
        iconType: toggle.iconType,
        tooltip: toggle.tooltip,
        toggledTooltip: toggle.toggledTooltip,
      });

      const response = await endpoint.call(client.actions, { client: "YTMUSIC" });
      if (response.success === false) {
        throw new Error(`Album library update returned HTTP ${response.status_code}.`);
      }
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setAlbumSaved failed", error, {
        albumId: album.id,
        saved,
      });
      throw new Error(
        saved
          ? "YouTube Music could not save this album."
          : "YouTube Music could not remove this album.",
      );
    }
  }

  private async refreshAlbumTracks(
    album: Album,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.albumRefreshPromises.get(album.id);
    if (!refresh) {
      refresh = this.fetchAlbumTracksFresh(album).finally(() => {
        this.albumRefreshPromises.delete(album.id);
      });
      this.albumRefreshPromises.set(album.id, refresh);
    }

    const value = await refresh;
    const changed = value.length > 0
      ? await setCachedJson(cacheKey, value)
      : false;
    return { changed, value };
  }

  private async fetchAlbumTracksFresh(album: Album): Promise<Track[]> {
    const client = await this.getMusicClient();
    const albumPage = await client.music.getAlbum(album.id);
    const initialItems = albumPage.contents
      .filter((item) => item.item_type === "song" || item.item_type === "video") as unknown as MusicItem[];
    const continuedTracks = await this.collectAllTracks(client, albumPage.page);
    const tracks = this.uniqueById([
      ...initialItems
        .map((item) => this.toTrack(item))
        .filter((item): item is Track => Boolean(item)),
      ...continuedTracks,
    ]);
    if (tracks.length === 0) {
      throw new Error(`YouTube Music returned no tracks for album ${album.id}.`);
    }
    return tracks;
  }

  async getArtist(
    artistId: string,
    onUpdate?: (artist: ArtistPage) => void,
  ): Promise<ArtistPage> {
    // v3 adds the subscribed field to the cached data
    const cacheKey = `youtube-music:artist:v3:${artistId}`;
    const cached = await getCachedJson<ArtistPage>(cacheKey);
    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshArtist(artistId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getArtist background refresh failed", {
              artistId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }
    return (await this.refreshArtist(artistId, cacheKey)).value;
  }

  async setArtistSubscribed(artistId: string, subscribed: boolean): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music to update subscriptions.");
    }
    try {
      const webClient = await this.getWebClient();
      const response = await webClient.actions.execute(
        subscribed ? "/subscription/subscribe" : "/subscription/unsubscribe",
        {
          channelIds: [artistId],
          params: "CgIIAhgA",
        },
      );
      if (!response.success) {
        throw new Error(`Artist subscription update returned HTTP ${response.status_code}.`);
      }
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setArtistSubscribed failed", error, {
        artistId,
        subscribed,
      });
      throw new Error(
        subscribed
          ? "YouTube Music could not subscribe to this artist."
          : "YouTube Music could not unsubscribe from this artist.",
      );
    }
  }

  private async refreshArtist(
    artistId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: ArtistPage }> {
    let refresh = this.artistRefreshPromises.get(artistId);
    if (!refresh) {
      refresh = this.fetchArtistFresh(artistId).finally(() => {
        this.artistRefreshPromises.delete(artistId);
      });
      this.artistRefreshPromises.set(artistId, refresh);
    }
    const value = await refresh;
    return { changed: await setCachedJson(cacheKey, value), value };
  }

  private async fetchArtistFresh(artistId: string): Promise<ArtistPage> {
    const client = await this.getMusicClient();
    const artistPage = await client.music.getArtist(artistId);
    const header = artistPage.header as unknown as {
      title?: { toString(): string };
      subtitle?: { toString(): string };
      description?: { toString(): string; runs?: Array<{ text?: string }> };
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      } | Array<{ url?: string; width?: number; height?: number }>;
      foreground_thumbnail?: Array<{ url?: string; width?: number; height?: number }>;
    } | undefined;
    const responseItems = this.collectMusicItems(
      artistPage.page,
      new Set(["artist", "song", "video", "album", "playlist"]),
    );
    const headerText = [
      header?.subtitle?.toString(),
      header?.description?.toString(),
      ...(header?.description?.runs?.map((run) => run.text) ?? []),
    ].filter(Boolean).join(" ");
    const artistItem = responseItems.find((item) => item.item_type === "artist");
    const subscriberCount = headerText.match(/[\d,.]+\s*[KMB]?\s+subscribers?/i)?.[0]
      ?? artistItem?.subscribers;
    const headerThumbnail = Array.isArray(header?.thumbnail)
      ? header.thumbnail
      : header?.thumbnail?.contents;
    const artist: Artist = {
      id: artistId,
      name: header?.title?.toString()
        || artistItem?.title?.toString()
        || "Artist",
      artworkUrl: selectArtworkUrl(
        collectArtworkCandidates(
          headerThumbnail,
          header?.foreground_thumbnail,
          artistItem?.thumbnail,
        ),
      ),
      subscriberCount,
    };

    const popularSongs: Track[] = [];
    const releases: Album[] = [];
    const playlists: Playlist[] = [];
    for (const section of artistPage.sections as unknown as Array<{
      title?: { toString(): string };
      header?: { title?: { toString(): string } };
      contents?: MusicItem[];
    }>) {
      const sectionTitle = (
        section.title?.toString()
        || section.header?.title?.toString()
        || ""
      ).toLocaleLowerCase();
      const contents = section.contents ?? [];
      if (sectionTitle.includes("song")) {
        popularSongs.push(
          ...contents
            .map((item) => this.toTrack(item))
            .filter((item): item is Track => Boolean(item)),
        );
      }
      if (
        sectionTitle.includes("album")
        || sectionTitle.includes("single")
        || sectionTitle.includes("ep")
        || sectionTitle.includes("release")
      ) {
        releases.push(
          ...contents
            .flatMap((item): Album[] => {
              const album = this.toAlbum(item);
              if (!album) return [];
              const itemMetadata = (item.subtitle?.toString() ?? "").toLocaleLowerCase();
              const combinedSection = sectionTitle.includes("single")
                && sectionTitle.includes("ep");
              const metadata = itemMetadata || (combinedSection ? "" : sectionTitle);
              const releaseType: Album["releaseType"] = metadata.includes("ep")
                ? "ep"
                : metadata.includes("single")
                  ? "single"
                  : sectionTitle.includes("single")
                    ? "single"
                    : "album";
              return [{ ...album, releaseType }];
            }),
        );
      }
      if (sectionTitle.includes("playlist")) {
        playlists.push(
          ...contents
            .map((item) => this.toPlaylist(item))
            .filter((item): item is Playlist => Boolean(item)),
        );
      }
    }

    if (popularSongs.length === 0) {
      popularSongs.push(
        ...responseItems
          .filter((item) => item.item_type === "song" || item.item_type === "video")
          .map((item) => this.toTrack(item))
          .filter((item): item is Track => Boolean(item)),
      );
    }
    if (releases.length === 0) {
      releases.push(
        ...responseItems
          .filter((item) => item.item_type === "album")
          .map((item) => this.toAlbum(item))
          .filter((item): item is Album => Boolean(item))
          .map((album) => ({ ...album, releaseType: "album" as const })),
      );
    }
    if (playlists.length === 0) {
      playlists.push(
        ...responseItems
          .filter((item) => item.item_type === "playlist")
          .map((item) => this.toPlaylist(item))
          .filter((item): item is Playlist => Boolean(item)),
      );
    }

    let allSongShelf: Awaited<ReturnType<typeof artistPage.getAllSongs>>;
    try {
      allSongShelf = await artistPage.getAllSongs();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.fetchArtistFresh all songs unavailable", {
        artistId,
        error: error instanceof Error ? error.message : String(error),
      });
      allSongShelf = undefined;
    }
    const allSongs = allSongShelf
      ? (allSongShelf.contents as unknown as MusicItem[])
        .map((item) => this.toTrack(item))
        .filter((item): item is Track => Boolean(item))
      : popularSongs;

    const enrichedPopularSongs = await Promise.all(
      this.uniqueById(popularSongs).slice(0, 6).map(async (track) => {
        if (track.viewCount) return track;
        try {
          const info = await client.getBasicInfo(track.id);
          const basic = (info as {
            basic_info?: {
              view_count?: number;
            };
          }).basic_info;
          return basic?.view_count
            ? {
                ...track,
                viewCount: basic.view_count,
                viewCountText: `${basic.view_count} views`,
              }
            : track;
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.fetchArtistFresh view count unavailable", {
            artistId,
            trackId: track.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return track;
        }
      }),
    );

    const subscriptionToggle = this.findArtistSubscriptionToggle(artistPage.page);
    const subscribed = subscriptionToggle?.subscribed;

    return {
      artist,
      subscribed,
      popularSongs: enrichedPopularSongs,
      allSongs: this.uniqueById(allSongs),
      releases: this.uniqueById(releases),
      playlists: this.uniqueById(playlists),
    };
  }

  async getPlaylistTracks(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const cacheKey = `youtube-music:playlist-tracks:v4:${playlist.id}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached?.length) {
      globalThis.setTimeout(() => {
        void this.refreshPlaylistTracks(playlist, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getPlaylistTracks background refresh failed", {
              playlistId: playlist.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getPlaylistTracks ignoring empty cache entry", {
        playlistId: playlist.id,
      });
    }

    return (await this.refreshPlaylistTracks(playlist, cacheKey)).value;
  }

  private async refreshPlaylistTracks(
    playlist: Playlist,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.playlistRefreshPromises.get(playlist.id);
    if (!refresh) {
      refresh = this.fetchPlaylistTracksFresh(playlist).finally(() => {
        this.playlistRefreshPromises.delete(playlist.id);
      });
      this.playlistRefreshPromises.set(playlist.id, refresh);
    }

    const value = await refresh;
    const changed = value.length > 0
      ? await setCachedJson(cacheKey, value)
      : false;
    return { changed, value };
  }

  private async fetchPlaylistTracksFresh(playlist: Playlist): Promise<Track[]> {
    const client = await this.getMusicClient();
    const tracks = await this.collectPlaylistTracks(client, playlist.id);
    if (tracks.length > 0) return tracks;

    const browseId = playlist.id.startsWith("VL") ? playlist.id : `VL${playlist.id}`;
    logInternalWarn("YouTubeMusicDataSource.fetchPlaylistTracksFresh retrying empty playlist response", {
      playlistId: playlist.id,
      browseId,
    });
    const response = await this.executeMusicBrowse(client, { browseId });
    return this.collectAllTracks(client, response);
  }

  async addTrackToPlaylist(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present"> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before adding songs to playlists.");
    }

    logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist start", {
      trackId: track.id,
      playlistId: playlist.id,
    });

    try {
      const client = await this.getMusicClient();
      const cacheKey = `youtube-music:playlist-tracks:v4:${playlist.id}`;
      const cachedTracks = await getCachedJson<Track[]>(cacheKey);
      const existingTracks = cachedTracks
        ?? await this.collectPlaylistTracks(client, playlist.id);
      if (existingTracks.some((item) => item.id === track.id)) {
        if (!cachedTracks) await setCachedJson(cacheKey, existingTracks);
        logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist already present", {
          trackId: track.id,
          playlistId: playlist.id,
          source: cachedTracks ? "cache" : "network",
        });
        return "already-present";
      }

      const editablePlaylistId = playlist.id.startsWith("VL")
        ? playlist.id.slice(2)
        : playlist.id;
      await client.playlist.addVideos(editablePlaylistId, [track.id]);

      let confirmedTracks: Track[] | null = null;
      for (const delayMs of [0, 500, 1500]) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
        }

        const tracks = await this.collectPlaylistTracks(client, playlist.id);
        if (tracks.some((item) => item.id === track.id)) {
          confirmedTracks = tracks;
          break;
        }
      }

      if (!confirmedTracks) {
        throw new Error("YouTube Music did not confirm the playlist update.");
      }

      await setCachedJson(cacheKey, confirmedTracks);

      logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist success", {
        trackId: track.id,
        playlistId: playlist.id,
      });
      return "added";
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.addTrackToPlaylist failed", error, {
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("YouTube Music could not add this song to the playlist.");
    }
  }

  async setPlaylistSaved(playlist: Playlist, saved: boolean): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }
    const client = await this.getMusicClient();
    const playlistId = playlist.id.startsWith("VL") ? playlist.id.slice(2) : playlist.id;
    try {
      if (saved) await client.playlist.addToLibrary(playlistId);
      else await client.playlist.removeFromLibrary(playlistId);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setPlaylistSaved failed", error, {
        playlistId,
        saved,
      });
      throw new Error(
        saved
          ? "YouTube Music could not save this playlist."
          : "YouTube Music could not remove this playlist.",
      );
    }
  }

  async removeTrackFromPlaylist(track: Track, playlist: Playlist): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before removing songs from playlists.");
    }
    if (!track.playlistItemId) {
      throw new Error("Reload the playlist before removing this song.");
    }

    logInternalInfo("YouTubeMusicDataSource.removeTrackFromPlaylist start", {
      trackId: track.id,
      playlistItemId: track.playlistItemId,
      playlistId: playlist.id,
    });

    try {
      const client = await this.getMusicClient();
      const cacheKey = `youtube-music:playlist-tracks:v4:${playlist.id}`;
      const editablePlaylistId = playlist.id.startsWith("VL")
        ? playlist.id.slice(2)
        : playlist.id;

      const response = await client.actions.execute("browse/edit_playlist", {
        playlistId: editablePlaylistId,
        actions: [
          {
            action: "ACTION_REMOVE_VIDEO",
            setVideoId: track.playlistItemId,
          },
        ],
      });
      if (!response.success) {
        throw new Error(`Playlist edit returned HTTP ${response.status_code}.`);
      }

      const cachedTracks = await getCachedJson<Track[]>(cacheKey);
      if (cachedTracks) {
        await setCachedJson(
          cacheKey,
          cachedTracks.filter((item) => item.playlistItemId !== track.playlistItemId),
        );
      }

      logInternalInfo("YouTubeMusicDataSource.removeTrackFromPlaylist success", {
        trackId: track.id,
        playlistItemId: track.playlistItemId,
        playlistId: playlist.id,
      });
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.removeTrackFromPlaylist failed", error, {
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("YouTube Music could not remove this song from the playlist.");
    }
  }

  async setTrackLiked(track: Track, liked: boolean): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to like songs.");
    }

    logInternalInfo("YouTubeMusicDataSource.setTrackLiked start", {
      trackId: track.id,
      liked,
    });

    try {
      const client = await this.getMusicClient();
      const response = await this.executeTrackLikeCommand(client, track.id, liked);

      if (!response.success) {
        throw new Error(`YouTube returned HTTP ${response.status_code}.`);
      }

      const cachedLibrary = await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
      if (cachedLibrary) {
        const likedSongs = liked
          ? this.uniqueById([track, ...cachedLibrary.likedSongs])
          : cachedLibrary.likedSongs.filter((item) => item.id !== track.id);
        await setCachedJson(LIBRARY_CACHE_KEY, {
          ...cachedLibrary,
          likedSongs,
        });
        await setCachedJson(
          `youtube-music:playlist-tracks:v4:${LIKED_SONGS_PLAYLIST_ID}`,
          likedSongs,
        );
      }

      logInternalInfo("YouTubeMusicDataSource.setTrackLiked success", {
        trackId: track.id,
        liked,
      });
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setTrackLiked failed", error, {
        trackId: track.id,
        liked,
      });
      throw new Error(liked
        ? "YouTube Music could not like this song."
        : "YouTube Music could not remove this like.");
    }
  }

  async getTrack(id: string): Promise<Track> {
    const trackId = id;
    if (!trackId) throw new Error("A track id is required.");
    const cacheKey = `youtube-music:track:v1:${trackId}`;
    const cached = await getCachedJson<Track>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshTrack(trackId, cacheKey).catch((error) => {
          logInternalWarn("YouTubeMusicDataSource.getTrack background refresh failed", {
            trackId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 0);
      return cached;
    }

    try {
      return await this.refreshTrack(trackId, cacheKey);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.getTrack failed", error, { trackId });
      return {
        id: trackId,
        source: "youtube",
        title: `Track (${trackId})`,
        artist: "Unknown artist",
      };
    }
  }

  async getLyrics(track: Track): Promise<Lyrics | null> {
    const cacheKey = `lyrics:synced:v2:${track.id}`;
    const cached = await getCachedJson<Lyrics>(cacheKey);
    if (cached?.timing === "synced" && cached.lines.length > 0) return cached;

    let refresh = this.lyricsRefreshPromises.get(track.id);
    if (!refresh) {
      refresh = this.fetchSyncedLyrics(track).finally(() => {
        this.lyricsRefreshPromises.delete(track.id);
      });
      this.lyricsRefreshPromises.set(track.id, refresh);
    }

    const lyrics = await refresh;
    if (lyrics) await setCachedJson(cacheKey, lyrics);
    return lyrics;
  }

  private async fetchSyncedLyrics(track: Track): Promise<Lyrics | null> {
    logInternalInfo("YouTubeMusicDataSource.getLyrics start", { trackId: track.id });
    const durationSec = track.durationSec;

    if (durationSec && durationSec > 0) {
      try {
        const params = new URLSearchParams({
          track_name: track.title,
          artist_name: track.artist,
        });
        const response = await tauriFetch(`https://lrclib.net/api/search?${params}`, {
          headers: {
            Accept: "application/json",
            "User-Agent": "JustAnotherMusicClient/0.1.0",
          },
        });

        if (response.ok) {
          const matches = await response.json() as LrcLibTrack[];
          const candidates = matches
            .filter((match) => match.syncedLyrics && typeof match.duration === "number")
            .map((match) => ({
              match,
              durationDelta: Math.abs((match.duration ?? 0) - durationSec),
            }))
            .filter(({ durationDelta }) => durationDelta <= 2)
            .sort((left, right) => left.durationDelta - right.durationDelta);
          const candidate = candidates[0];

          if (candidate?.match.syncedLyrics) {
            const { durationDelta } = candidate;
            const lines = this.parseSyncedLyrics(candidate.match.syncedLyrics);
            if (lines.length > 0) {
              logInternalInfo("YouTubeMusicDataSource.getLyrics LRCLIB success", {
                trackId: track.id,
                lineCount: lines.length,
                durationDelta,
              });
              return {
                lines,
                timing: "synced",
                sourceLabel: "LRCLIB",
              };
            }
          }
        }
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getLyrics LRCLIB unavailable", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const webClient = await this.getWebClient();
      const info = await webClient.getInfo(track.id);
      const transcript = await info.getTranscript();
      const segments = transcript.transcript.content?.body?.initial_segments ?? [];
      const timedLines = segments.flatMap((segment) => {
        const item = segment as unknown as {
          start_ms?: string;
          end_ms?: string;
          snippet?: { toString(): string };
        };
        const text = item.snippet?.toString().trim();
        const startTimeMs = Number(item.start_ms);
        const endTimeMs = Number(item.end_ms);
        if (!text || !Number.isFinite(startTimeMs)) return [];

        return [{
          text,
          startTimeSec: startTimeMs / 1000,
          endTimeSec: Number.isFinite(endTimeMs) ? endTimeMs / 1000 : undefined,
        }];
      });

      if (timedLines.length > 0) {
        logInternalInfo("YouTubeMusicDataSource.getLyrics timed transcript success", {
          trackId: track.id,
          lineCount: timedLines.length,
        });
        return {
          lines: timedLines,
          timing: "synced",
          sourceLabel: "YouTube",
        };
      }
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getLyrics timed transcript unavailable", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  private parseSyncedLyrics(lrc: string): Lyrics["lines"] {
    const lines: Lyrics["lines"] = [];
    const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

    for (const rawLine of lrc.split(/\r?\n/)) {
      const text = rawLine.replace(timestampPattern, "").trim();
      if (!text) continue;

      const timestamps = [...rawLine.matchAll(timestampPattern)];
      for (const timestamp of timestamps) {
        const minutes = Number(timestamp[1]);
        const seconds = Number(timestamp[2]);
        const fraction = timestamp[3] ?? "0";
        const fractionSec = Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
        lines.push({
          text,
          startTimeSec: minutes * 60 + seconds + fractionSec,
        });
      }
    }

    lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
    return lines.map((line, index) => ({
      ...line,
      endTimeSec: lines[index + 1]?.startTimeSec,
    }));
  }

  private async refreshTrack(trackId: string, cacheKey: string): Promise<Track> {
    let refresh = this.trackRefreshPromises.get(trackId);
    if (!refresh) {
      refresh = this.fetchTrackFresh(trackId).finally(() => {
        this.trackRefreshPromises.delete(trackId);
      });
      this.trackRefreshPromises.set(trackId, refresh);
    }

    const track = await refresh;
    await setCachedJson(cacheKey, track);
    return track;
  }

  private async fetchTrackFresh(trackId: string): Promise<Track> {
    logInternalInfo("YouTubeMusicDataSource.getTrack start", { trackId });
    const yt = await this.getMusicClient();
    const info = await yt.getBasicInfo(trackId);
    const basic = (info as any).basic_info;
    const artwork = selectArtworkUrl(basic?.thumbnail);
    const track: Track = {
      id: basic?.id ?? trackId,
      source: "youtube",
      title: basic?.title ?? `Track (${trackId})`,
      artist: basic?.author ?? "Unknown artist",
      artists: basic?.channel_id && basic?.author
        ? [{ id: basic.channel_id, name: basic.author }]
        : undefined,
      durationSec: basic?.duration,
      artworkUrl: artwork,
    };

    logInternalInfo("YouTubeMusicDataSource.getTrack success", {
      trackId: track.id,
      title: track.title,
    });
    return track;
  }

  async search(
    query: string,
    onUpdate?: (results: SearchResults) => void,
  ): Promise<SearchResults> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { artists: [], tracks: [], albums: [], playlists: [] };
    }
    const cacheId = normalizedQuery.toLocaleLowerCase();
    const cacheKey = `youtube-music:mixed-search:v3:${cacheId}`;
    const cached = await getCachedJson<SearchResults>(cacheKey);
    if (cached && this.hasSearchResults(cached)) {
      globalThis.setTimeout(() => {
        void this.refreshMixedSearch(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.search background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }
    return (await this.refreshMixedSearch(normalizedQuery, cacheId, cacheKey)).value;
  }

  private async refreshMixedSearch(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: SearchResults }> {
    let refresh = this.mixedSearchRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchMixedSearchFresh(query).finally(() => {
        this.mixedSearchRefreshPromises.delete(cacheId);
      });
      this.mixedSearchRefreshPromises.set(cacheId, refresh);
    }
    const value = await refresh;
    return { changed: await setCachedJson(cacheKey, value), value };
  }

  private async fetchMixedSearchFresh(query: string): Promise<SearchResults> {
    const client = await this.getMusicClient();
    const [response, artistResponse] = await Promise.all([
      client.music.search(query),
      client.music.search(query, { type: "artist" }).catch(() => null),
    ]);
    const fromShelf = <T>(
      shelf: { contents?: unknown[] } | undefined,
      mapper: (item: MusicItem) => T | null,
    ): T[] => (shelf?.contents ?? [])
      .map((item) => mapper(item as MusicItem))
      .filter((item): item is T => Boolean(item));

    const libraryPlaylistIds = new Set(
      this.libraryRefreshPromise
        ? []
        : (await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY))?.playlists.map(
          (playlist) => playlist.id.replace(/^VL/, ""),
        ) ?? [],
    );
    const fallbackItems = this.collectMusicItems(
      response.page,
      new Set(["artist", "song", "video", "album", "playlist"]),
    );
    const artistFallbackItems = artistResponse
      ? this.collectMusicItems(artistResponse.page, new Set(["artist"]))
      : [];
    const shelfArtists = fromShelf(response.artists, (item) => this.toArtist(item));
    const shelfTracks = fromShelf(response.songs, (item) => this.toTrack(item));
    const shelfAlbums = fromShelf(response.albums, (item) => this.toAlbum(item));
    const shelfPlaylists = fromShelf(response.playlists, (item) => this.toPlaylist(item));
    const playlists = [
      ...shelfPlaylists,
      ...fallbackItems
        .filter((item) => item.item_type === "playlist")
        .map((item) => this.toPlaylist(item))
        .filter((item): item is Playlist => Boolean(item)),
    ]
      .map((playlist) => ({
        ...playlist,
        isSaved: libraryPlaylistIds.has(playlist.id.replace(/^VL/, "")),
      }));

    const results = {
      artists: this.uniqueById([
        ...shelfArtists,
        ...fromShelf(artistResponse?.artists, (item) => this.toArtist(item)),
        ...fallbackItems
          .filter((item) => item.item_type === "artist")
          .map((item) => this.toArtist(item))
          .filter((item): item is Artist => Boolean(item)),
        ...artistFallbackItems
          .map((item) => this.toArtist(item))
          .filter((item): item is Artist => Boolean(item)),
      ]),
      tracks: this.uniqueById([
        ...shelfTracks,
        ...fallbackItems
          .filter((item) => item.item_type === "song" || item.item_type === "video")
          .map((item) => this.toTrack(item))
          .filter((item): item is Track => Boolean(item)),
      ]),
      albums: this.uniqueById([
        ...shelfAlbums,
        ...fallbackItems
          .filter((item) => item.item_type === "album")
          .map((item) => this.toAlbum(item))
          .filter((item): item is Album => Boolean(item)),
      ]),
      playlists: this.uniqueById(playlists),
    };
    if (this.hasSearchResults(results)) return results;

    const tracks = await this.fetchSearchTracksFresh(query);
    return { artists: [], tracks, albums: [], playlists: [] };
  }

  private hasSearchResults(results: SearchResults): boolean {
    return results.artists.length > 0
      || results.tracks.length > 0
      || results.albums.length > 0
      || results.playlists.length > 0;
  }

  async searchTracks(query: string, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const cacheId = normalizedQuery.toLowerCase();
    const cacheKey = `youtube-music:search:v1:${cacheId}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshSearchTracks(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.searchTracks background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    return (await this.refreshSearchTracks(normalizedQuery, cacheId, cacheKey)).value;
  }

  private async refreshSearchTracks(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.searchRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchSearchTracksFresh(query).finally(() => {
        this.searchRefreshPromises.delete(cacheId);
      });
      this.searchRefreshPromises.set(cacheId, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchSearchTracksFresh(normalizedQuery: string): Promise<Track[]> {
    logInternalInfo("YouTubeMusicDataSource.searchTracks start", {
      query: normalizedQuery,
    });

    try {
      const client = await this.getMusicClient();
      const response = await client.music.search(normalizedQuery, { type: "song" });
      const tracks = this.uniqueById(
        (response.songs?.contents ?? [])
        .map((item) => this.toTrack(item as unknown as MusicItem))
          .filter((item): item is Track => Boolean(item)),
      );

      logInternalInfo("YouTubeMusicDataSource.searchTracks success", {
        query: normalizedQuery,
        trackCount: tracks.length,
      });
      return tracks;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.searchTracks failed", error, {
        query: normalizedQuery,
      });
      throw new Error("Unable to search for songs.");
    }
  }

  async getSearchSuggestions(
    query: string,
    onUpdate?: (suggestions: string[]) => void,
  ): Promise<string[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const cacheId = normalizedQuery.toLowerCase();
    const cacheKey = `youtube-music:search-suggestions:v1:${cacheId}`;
    const cached = await getCachedJson<string[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshSearchSuggestions(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getSearchSuggestions background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    try {
      return (await this.refreshSearchSuggestions(normalizedQuery, cacheId, cacheKey)).value;
    } catch {
      return [];
    }
  }

  private async refreshSearchSuggestions(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: string[] }> {
    let refresh = this.suggestionRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchSearchSuggestionsFresh(query).finally(() => {
        this.suggestionRefreshPromises.delete(cacheId);
      });
      this.suggestionRefreshPromises.set(cacheId, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchSearchSuggestionsFresh(normalizedQuery: string): Promise<string[]> {
    try {
      const client = await this.getMusicClient();
      const sections = await client.music.getSearchSuggestions(normalizedQuery);
      const suggestions = sections.flatMap((section) =>
        section.contents
          .map((item) => {
            const suggestion = item as {
              suggestion?: { toString(): string };
            };
            return suggestion.suggestion?.toString() ?? "";
          })
          .filter(Boolean)
      );

      return [...new Set(suggestions)].slice(0, 3);
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getSearchSuggestions failed", {
        query: normalizedQuery,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("Unable to load search suggestions.");
    }
  }

  async getRecommendations(
    seed: Track,
    onUpdate?: (tracks: Track[]) => void,
  ): Promise<Track[]> {
    const cacheKey = `youtube-music:recommendations:v1:${seed.id}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshRecommendations(seed, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getRecommendations background refresh failed", {
              seedTrackId: seed.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    try {
      return (await this.refreshRecommendations(seed, cacheKey)).value;
    } catch {
      return [];
    }
  }

  private async refreshRecommendations(
    seed: Track,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.recommendationRefreshPromises.get(seed.id);
    if (!refresh) {
      refresh = this.fetchRecommendationsFresh(seed).finally(() => {
        this.recommendationRefreshPromises.delete(seed.id);
      });
      this.recommendationRefreshPromises.set(seed.id, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchRecommendationsFresh(seed: Track): Promise<Track[]> {
    logInternalInfo("YouTubeMusicDataSource.getRecommendations start", {
      seedTrackId: seed.id,
    });

    try {
      const client = await this.getMusicClient();
      const panel = await client.music.getUpNext(seed.id, true);
      const recommendationTracks: Track[] = [];
      for (const entry of panel.contents) {
        const item = entry as unknown as UpNextItem;
        const video = item.primary ?? item;
        const id = video.video_id;
        const title = video.title?.toString();
        if (!id || !title || id === seed.id) continue;

        recommendationTracks.push({
          id,
          source: "youtube",
          title,
          artist: video.artists?.map((artist) => artist.name).filter(Boolean).join(", ")
            || video.author
            || "Unknown artist",
          durationSec: video.duration?.seconds,
          artworkUrl: selectArtworkUrl(video.thumbnail) ?? getVideoArtworkFallback(id),
        });
      }
      const tracks = this.uniqueById(recommendationTracks);

      logInternalInfo("YouTubeMusicDataSource.getRecommendations success", {
        seedTrackId: seed.id,
        trackCount: tracks.length,
      });
      return tracks;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.getRecommendations failed", error, {
        seedTrackId: seed.id,
      });
      throw new Error("Unable to load recommendations.");
    }
  }

  async getStreamUrl(track: Track): Promise<string> {
    logInternalInfo("YouTubeMusicDataSource.getStreamUrl start", { trackId: track.id });

    for (const label of ["music", "web"] as ClientLabel[]) {
      try {
        const yt = await this.getClient(label);
        const format = await yt.getStreamingData(track.id, { type: "audio", quality: "best" });
        const url = typeof (format as any).url === "string"
          ? (format as any).url
          : await format.decipher(yt.session.player);

        if (!url) {
          throw new Error("YouTube.js returned an empty stream URL.");
        }

        logInternalInfo("YouTubeMusicDataSource.getStreamUrl success", {
          trackId: track.id,
          client: label,
          itag: (format as any).itag ?? null,
          mimeType: (format as any).mime_type ?? null,
          urlLength: url.length,
        });

        return url;
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getStreamUrl client failed", {
          trackId: track.id,
          client: label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logInternalError(
      "YouTubeMusicDataSource.getStreamUrl failed",
      new Error("No YouTube client returned a playable audio URL."),
      { trackId: track.id },
    );
    throw new Error("Unable to resolve a playable YouTube audio stream.");
  }

  async getStreamData(track: Track): Promise<StreamData> {
    logInternalInfo("YouTubeMusicDataSource.getStreamData download start", {
      trackId: track.id,
    });

    const payload = await invoke<NativeAudioPayload>("fetch_youtube_music_audio", {
      videoId: track.id,
    });
    const audioBytes = decodeBase64(payload.bodyBase64);
    if (audioBytes.byteLength === 0) {
      throw new Error("Audio download returned no data.");
    }

    logInternalInfo("YouTubeMusicDataSource.getStreamData download success", {
      trackId: track.id,
      byteLength: audioBytes.byteLength,
      mimeType: payload.mimeType,
    });

    return {
      bytes: audioBytes.buffer.slice(
        audioBytes.byteOffset,
        audioBytes.byteOffset + audioBytes.byteLength,
      ) as ArrayBuffer,
      mimeType: payload.mimeType,
    };
  }
}
