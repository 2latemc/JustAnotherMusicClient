interface ArtworkCandidate {
  url?: string;
  width?: number;
  height?: number;
}

function normalizeArtworkUrl(url: string): string {
  const trimmedUrl = url.trim();
  return trimmedUrl.startsWith("//") ? `https:${trimmedUrl}` : trimmedUrl;
}

function isArtworkCandidate(value: unknown): value is ArtworkCandidate {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as ArtworkCandidate).url === "string",
  );
}

export function collectArtworkCandidates(...sources: unknown[]): ArtworkCandidate[] {
  const candidates: ArtworkCandidate[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (isArtworkCandidate(value)) {
      candidates.push(value);
    }

    for (const child of Object.values(value)) {
      if (Array.isArray(child) || (child && typeof child === "object")) {
        visit(child);
      }
    }
  };

  for (const source of sources) {
    visit(source);
  }

  return candidates;
}

export function selectArtworkUrl(
  ...candidateGroups: Array<readonly ArtworkCandidate[] | null | undefined>
): string | undefined {
  const candidates = candidateGroups
    .flatMap((group) => group ?? [])
    .filter((candidate): candidate is ArtworkCandidate & { url: string } => Boolean(candidate.url?.trim()));

  const bestCandidate = candidates.reduce<(ArtworkCandidate & { url: string }) | undefined>(
    (best, candidate) => {
      if (!best) return candidate;

      const bestArea = (best.width ?? 0) * (best.height ?? 0);
      const candidateArea = (candidate.width ?? 0) * (candidate.height ?? 0);
      return candidateArea > bestArea ? candidate : best;
    },
    undefined,
  );

  return bestCandidate ? normalizeArtworkUrl(bestCandidate.url) : undefined;
}

function withYoutubeSize(url: string, size: number): string | null {
  if (!/googleusercontent\.com|ggpht\.com|yt3\.ggpht\.com/.test(url)) return null;
  if (/[?&]/.test(url)) return null;
  if (/=/.test(url)) {
    return url.replace(/=[^=/]+$/, `=w${size}-h${size}-l90-rj`);
  }
  return `${url}=w${size}-h${size}-l90-rj`;
}

export function getArtworkUrlCandidates(url?: string): string[] {
  if (!url?.trim()) return [];

  const normalized = normalizeArtworkUrl(url);
  const candidates = [
    normalized,
    withYoutubeSize(normalized, 544),
    withYoutubeSize(normalized, 240),
    withYoutubeSize(normalized, 120),
  ].filter((candidate): candidate is string => Boolean(candidate));

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

export function getVideoArtworkFallback(videoId: string): string | undefined {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId)
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    : undefined;
}
