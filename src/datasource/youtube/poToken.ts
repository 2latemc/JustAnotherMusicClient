import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { logInternalInfo, logInternalWarn } from "../../internal/logging";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const FALLBACK_TTL_SECONDS = 12 * 60 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type CachedMinter = { minter: WebPoMinter; expiresAt: number };

let cached: Promise<CachedMinter> | null = null;

const attestationFetch: typeof fetch = (...args) => globalThis.fetch(...args);

async function attest(): Promise<CachedMinter> {
  const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: attestationFetch });
  const interpreterJavascript =
    challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJavascript) {
    throw new Error("BotGuard challenge carried no interpreter script.");
  }

  const interpreterId = challenge.interpreterHash ?? "botguard-interpreter";
  if (!document.getElementById(interpreterId)) {
    const script = document.createElement("script");
    script.id = interpreterId;
    script.type = "text/javascript";
    script.textContent = interpreterJavascript;
    document.head.appendChild(script);
  }

  const botguard = await BotGuardClient.create({
    globalName: challenge.globalName,
    globalObject: window,
    program: challenge.program,
  });
  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

  const response = await attestationFetch(buildURL("GenerateIT"), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!response.ok) {
    throw new Error(`Integrity token request returned HTTP ${response.status}.`);
  }

  const [integrityToken, estimatedTtlSecs, , websafeFallbackToken] = (await response.json()) as [
    string?,
    number?,
    number?,
    string?,
  ];
  logInternalInfo("poToken.integrity issued", {
    hasToken: Boolean(integrityToken),
    fallbackPresent: Boolean(websafeFallbackToken),
    ttlSeconds: estimatedTtlSecs ?? null,
  });
  if (!integrityToken) {
    throw new Error("Integrity token response contained no token.");
  }

  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  const ttlMs = (estimatedTtlSecs ?? FALLBACK_TTL_SECONDS) * 1000;
  logInternalInfo("poToken.attest succeeded", {
    ttlSeconds: estimatedTtlSecs ?? FALLBACK_TTL_SECONDS,
  });
  return { minter, expiresAt: Date.now() + Math.max(ttlMs - REFRESH_MARGIN_MS, 0) };
}

function getMinter(): Promise<CachedMinter> {
  if (!cached) {
    cached = attest().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

export async function mintPoToken(contentBinding: string): Promise<string | undefined> {
  if (!contentBinding) return undefined;

  try {
    let entry = await getMinter();
    if (Date.now() >= entry.expiresAt) {
      cached = null;
      entry = await getMinter();
    }
    return await entry.minter.mintAsWebsafeString(contentBinding);
  } catch (error) {
    logInternalWarn("poToken.mint failed, continuing without one", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
