const SONGLINK_ENDPOINT = "https://api.song.link/v1-alpha.1/links";
const ITUNES_LOOKUP_ENDPOINT = "https://itunes.apple.com/lookup";
const ITUNES_SEARCH_ENDPOINT = "https://itunes.apple.com/search";
const SPOTIFY_TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_ENDPOINT = "https://api.spotify.com/v1/search";
const SPOTIFY_TRACK_ENDPOINT = "https://api.spotify.com/v1/tracks";
const DEFAULT_COUNTRY = "US";
const MIN_SPOTIFY_SCORE = 0.78;
const MIN_APPLE_MUSIC_SCORE = 0.78;
const CLIENT_WINDOW_MS = 60000;
const CLIENT_MAX_REQUESTS = 20;
const SPOTIFY_REQUEST_INTERVAL_MS = 700;
const SPOTIFY_SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SPOTIFY_SEARCH_CACHE_MAX = 200;
const APPLE_MUSIC_SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const APPLE_MUSIC_SEARCH_CACHE_MAX = 200;

let spotifyTokenCache = {
  accessToken: "",
  expiresAt: 0,
};

const clientRateLimitStore = new Map();
const spotifySearchCache = new Map();
const appleMusicSearchCache = new Map();
let spotifyRequestQueue = Promise.resolve();
let nextSpotifyRequestAt = 0;

module.exports = async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  const rateLimit = checkClientRateLimit(getClientRateLimitKey(request));

  if (!rateLimit.allowed) {
    response.setHeader("Retry-After", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
    response.status(429).json({ error: "Too many requests. Please slow down for a moment." });
    return;
  }

  const source = normalizeMusicUrl(request.query.url);
  const userCountry = normalizeCountry(request.query.userCountry);

  if (!source.url) {
    response.status(400).json({ error: "Use a music.apple.com or open.spotify.com song link." });
    return;
  }

  try {
    const songlinkResponse = await fetchSonglinkPayload(source.url, userCountry);
    const payload = songlinkResponse.payload;

    if (!songlinkResponse.ok) {
      response.status(songlinkResponse.status).json(payload);
      return;
    }

    payload.sourcePlatform = source.platform;
    payload.targetPlatform = source.platform === "spotify" ? "appleMusic" : "spotify";

    if (source.platform === "appleMusic" && !payload.linksByPlatform?.spotify?.url) {
      try {
        await attachSpotifySearchMatch(payload, source.url, userCountry);
      } catch (spotifyError) {
        payload.spotifyMatch = {
          source: "search-fallback",
          reason: spotifyError.publicReason || "spotify_lookup_failed",
        };

        if (spotifyError.retryAfterSeconds) {
          payload.spotifyMatch.retryAfterSeconds = spotifyError.retryAfterSeconds;
          response.setHeader("Retry-After", String(spotifyError.retryAfterSeconds));
        }
      }
    }

    if (source.platform === "spotify" && !payload.linksByPlatform?.appleMusic?.url) {
      try {
        await attachAppleMusicSearchMatch(payload, source.url, userCountry);
      } catch (appleMusicError) {
        payload.appleMusicMatch = {
          source: "search-fallback",
          reason: appleMusicError.publicReason || "apple_music_lookup_failed",
        };
      }
    }

    response.status(songlinkResponse.status);
    response.json(payload);
  } catch (error) {
    response.status(502).json({ error: "Songlink request failed." });
  }
};

async function fetchSonglinkPayload(appleUrl, userCountry) {
  const endpoint = new URL(SONGLINK_ENDPOINT);
  endpoint.searchParams.set("url", appleUrl);
  endpoint.searchParams.set("userCountry", userCountry);

  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
    },
  });

  return {
    ok: response.ok,
    status: response.status,
    payload: await response.json(),
  };
}

async function attachSpotifySearchMatch(payload, appleUrl, userCountry) {
  const credentials = getSpotifyCredentials();
  const appleMetadata = await getAppleMetadata(appleUrl, userCountry);
  const sourceEntity = pickSourceEntity(payload);
  const target = {
    title: appleMetadata.trackName || sourceEntity.title || "",
    artistName: appleMetadata.artistName || sourceEntity.artistName || "",
    albumName: appleMetadata.collectionName || "",
    durationMs: appleMetadata.trackTimeMillis || null,
    thumbnailUrl: appleMetadata.artworkUrl100 || sourceEntity.thumbnailUrl || "",
  };

  payload.appleMusicMetadata = target;

  if (!credentials) {
    payload.spotifyMatch = {
      source: "search-fallback",
      reason: "missing_spotify_credentials",
    };
    return;
  }

  if (!target.title || !target.artistName) {
    payload.spotifyMatch = {
      source: "search-fallback",
      reason: "missing_track_metadata",
    };
    return;
  }

  const token = await getSpotifyAccessToken(credentials);
  const candidates = await searchSpotifyTracks(token, target, userCountry);
  const match = findBestSpotifyTrack(candidates, target);

  if (!match || match.score < MIN_SPOTIFY_SCORE) {
    payload.spotifyMatch = {
      source: "search-fallback",
      reason: "no_confident_spotify_match",
      bestScore: match?.score ?? 0,
    };
    return;
  }

  const entityUniqueId = `SPOTIFY_SONG::${match.track.id}`;
  payload.entitiesByUniqueId = payload.entitiesByUniqueId || {};
  payload.linksByPlatform = payload.linksByPlatform || {};
  payload.entitiesByUniqueId[entityUniqueId] = spotifyTrackToEntity(match.track);
  payload.linksByPlatform.spotify = {
    country: userCountry,
    url: match.track.external_urls.spotify,
    nativeAppUriDesktop: match.track.uri,
    entityUniqueId,
  };
  payload.spotifyMatch = {
    source: "spotify-search",
    confidence: Number(match.score.toFixed(3)),
    query: match.query,
  };
}

async function attachAppleMusicSearchMatch(payload, spotifyUrl, userCountry) {
  const sourceEntity = pickSourceEntity(payload);
  const spotifyMetadata =
    sourceEntity.title && sourceEntity.artistName
      ? {}
      : await getSpotifyTrackMetadata(spotifyUrl, userCountry);
  const target = {
    title: spotifyMetadata.name || sourceEntity.title || "",
    artistName:
      spotifyMetadata.artists?.map((artist) => artist.name).join(", ") ||
      sourceEntity.artistName ||
      "",
    albumName: spotifyMetadata.album?.name || "",
    durationMs: spotifyMetadata.duration_ms || null,
    thumbnailUrl: spotifyMetadata.album?.images?.[0]?.url || sourceEntity.thumbnailUrl || "",
  };

  payload.spotifyMetadata = target;

  if (!target.title || !target.artistName) {
    payload.appleMusicMatch = {
      source: "search-fallback",
      reason: "missing_track_metadata",
    };
    return;
  }

  const candidates = await searchAppleMusicTracks(target, userCountry);
  const match = findBestAppleMusicTrack(candidates, target);

  if (!match || match.score < MIN_APPLE_MUSIC_SCORE) {
    payload.appleMusicMatch = {
      source: "search-fallback",
      reason: "no_confident_apple_music_match",
      bestScore: match?.score ?? 0,
    };
    return;
  }

  const entityUniqueId = `APPLE_MUSIC_SONG::${match.track.trackId}`;
  payload.entitiesByUniqueId = payload.entitiesByUniqueId || {};
  payload.linksByPlatform = payload.linksByPlatform || {};
  payload.entitiesByUniqueId[entityUniqueId] = appleTrackToEntity(match.track);
  payload.linksByPlatform.appleMusic = {
    country: userCountry,
    url: match.track.trackViewUrl,
    nativeAppUriDesktop: match.track.trackViewUrl,
    entityUniqueId,
  };
  payload.appleMusicMatch = {
    source: "itunes-search",
    confidence: Number(match.score.toFixed(3)),
    query: match.query,
  };
}

function getSpotifyCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
}

async function getSpotifyAccessToken({ clientId, clientSecret }) {
  if (
    spotifyTokenCache.accessToken &&
    spotifyTokenCache.expiresAt > Date.now() + 30000
  ) {
    return spotifyTokenCache.accessToken;
  }

  const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64",
      )}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!response.ok) {
    throw new Error("Spotify authentication failed.");
  }

  const payload = await response.json();
  spotifyTokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(0, payload.expires_in - 60) * 1000,
  };

  return spotifyTokenCache.accessToken;
}

function throttledSpotifyFetch(url, options) {
  const run = spotifyRequestQueue
    .catch(() => {})
    .then(async () => {
      const waitMs = Math.max(0, nextSpotifyRequestAt - Date.now());

      if (waitMs) {
        await delay(waitMs);
      }

      nextSpotifyRequestAt = Date.now() + SPOTIFY_REQUEST_INTERVAL_MS;
      const response = await fetch(url, options);

      if (response.status === 429) {
        const retryAfterMs = readRetryAfterMs(response);
        nextSpotifyRequestAt = Math.max(nextSpotifyRequestAt, Date.now() + retryAfterMs);
      }

      return response;
    });

  spotifyRequestQueue = run.catch(() => {});
  return run;
}

async function searchSpotifyTracks(token, target, userCountry) {
  const cacheKey = getSpotifySearchCacheKey(target, userCountry);
  const cachedTracks = readSpotifySearchCache(cacheKey);

  if (cachedTracks) {
    return cachedTracks;
  }

  const queries = buildSpotifyQueries(target);
  const seen = new Set();
  const tracks = [];

  for (const query of queries) {
    const endpoint = new URL(SPOTIFY_SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("type", "track");
    endpoint.searchParams.set("market", userCountry);
    endpoint.searchParams.set("limit", "10");

    const response = await throttledSpotifyFetch(endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 429) {
      throw spotifyRateLimitError(response);
    }

    if (!response.ok) {
      continue;
    }

    const payload = await response.json();

    for (const track of payload.tracks?.items || []) {
      if (!track?.id || seen.has(track.id)) {
        continue;
      }

      seen.add(track.id);
      tracks.push({ track, query });
    }
  }

  writeSpotifySearchCache(cacheKey, tracks);
  return tracks;
}

async function getSpotifyTrackMetadata(spotifyUrl, userCountry) {
  const credentials = getSpotifyCredentials();
  const trackId = extractSpotifyTrackId(spotifyUrl);

  if (!credentials || !trackId) {
    return {};
  }

  try {
    const token = await getSpotifyAccessToken(credentials);
    const endpoint = new URL(`${SPOTIFY_TRACK_ENDPOINT}/${trackId}`);
    endpoint.searchParams.set("market", userCountry);

    const response = await throttledSpotifyFetch(endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 429) {
      throw spotifyRateLimitError(response);
    }

    if (!response.ok) {
      return {};
    }

    return response.json();
  } catch (error) {
    if (error.publicReason === "spotify_rate_limited") {
      throw error;
    }

    return {};
  }
}

async function searchAppleMusicTracks(target, userCountry) {
  const cacheKey = getAppleMusicSearchCacheKey(target, userCountry);
  const cachedTracks = readAppleMusicSearchCache(cacheKey);

  if (cachedTracks) {
    return cachedTracks;
  }

  const queries = buildAppleMusicQueries(target);
  const seen = new Set();
  const tracks = [];

  for (const query of queries) {
    const endpoint = new URL(ITUNES_SEARCH_ENDPOINT);
    endpoint.searchParams.set("term", query);
    endpoint.searchParams.set("country", userCountry);
    endpoint.searchParams.set("media", "music");
    endpoint.searchParams.set("entity", "song");
    endpoint.searchParams.set("limit", "12");

    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      continue;
    }

    const payload = await response.json();

    for (const track of payload.results || []) {
      if (!track?.trackId || seen.has(track.trackId)) {
        continue;
      }

      seen.add(track.trackId);
      tracks.push({ track, query });
    }
  }

  writeAppleMusicSearchCache(cacheKey, tracks);
  return tracks;
}

function buildSpotifyQueries(target) {
  const title = cleanQueryPart(target.title);
  const artist = cleanQueryPart(target.artistName);
  const album = cleanQueryPart(target.albumName);

  return [
    `track:"${title}" artist:"${artist}"`,
    album ? `track:"${title}" artist:"${artist}" album:"${album}"` : "",
    `${artist} ${title}`,
    album ? `${artist} ${title} ${album}` : "",
  ].filter(Boolean);
}

function buildAppleMusicQueries(target) {
  const title = cleanQueryPart(target.title);
  const artist = cleanQueryPart(target.artistName);
  const album = cleanQueryPart(target.albumName);

  return [
    `${artist} ${title}`,
    album ? `${artist} ${title} ${album}` : "",
    title,
  ].filter(Boolean);
}

function findBestSpotifyTrack(candidates, target) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreSpotifyTrack(candidate.track, target),
    }))
    .sort((left, right) => right.score - left.score)[0];
}

function findBestAppleMusicTrack(candidates, target) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreAppleMusicTrack(candidate.track, target),
    }))
    .sort((left, right) => right.score - left.score)[0];
}

function scoreSpotifyTrack(track, target) {
  const titleScore = stringSimilarity(track.name, target.title);
  const artists = Array.isArray(track.artists) ? track.artists : [];
  const artistScore = Math.max(
    ...artists.map((artist) => stringSimilarity(artist.name, target.artistName)),
    0,
  );
  const albumScore = target.albumName
    ? stringSimilarity(track.album?.name || "", target.albumName)
    : 0.65;
  const durationScore = target.durationMs
    ? scoreDuration(track.duration_ms, target.durationMs)
    : 0.65;
  const versionPenalty = getVersionPenalty(track.name, target.title);

  return (
    titleScore * 0.44 +
    artistScore * 0.34 +
    albumScore * 0.1 +
    durationScore * 0.12 -
    versionPenalty
  );
}

function scoreAppleMusicTrack(track, target) {
  const titleScore = stringSimilarity(track.trackName, target.title);
  const artistScore = stringSimilarity(track.artistName, target.artistName);
  const albumScore = target.albumName
    ? stringSimilarity(track.collectionName || "", target.albumName)
    : 0.65;
  const durationScore = target.durationMs
    ? scoreDuration(track.trackTimeMillis, target.durationMs)
    : 0.65;
  const versionPenalty = getVersionPenalty(track.trackName, target.title);

  return (
    titleScore * 0.44 +
    artistScore * 0.34 +
    albumScore * 0.1 +
    durationScore * 0.12 -
    versionPenalty
  );
}

function scoreDuration(candidateDuration, targetDuration) {
  const delta = Math.abs(candidateDuration - targetDuration);

  if (delta <= 2500) return 1;
  if (delta <= 6000) return 0.86;
  if (delta <= 12000) return 0.62;
  if (delta <= 25000) return 0.35;

  return 0;
}

function getVersionPenalty(candidateTitle, targetTitle) {
  const candidate = normalizeText(candidateTitle);
  const target = normalizeText(targetTitle);
  const versionWords = ["live", "remix", "karaoke", "instrumental", "sped up", "slowed"];

  return versionWords.some((word) => candidate.includes(word) && !target.includes(word))
    ? 0.18
    : 0;
}

function stringSimilarity(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);

  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return 0.9;
  }

  const leftTokens = new Set(normalizedLeft.split(" ").filter(Boolean));
  const rightTokens = new Set(normalizedRight.split(" ").filter(Boolean));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;

  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanQueryPart(value) {
  return String(value || "").replace(/"/g, "").trim();
}

function spotifyTrackToEntity(track) {
  const image = track.album?.images?.[0] || {};

  return {
    id: track.id,
    type: "song",
    title: track.name,
    artistName: track.artists.map((artist) => artist.name).join(", "),
    thumbnailUrl: image.url,
    thumbnailWidth: image.width,
    thumbnailHeight: image.height,
    apiProvider: "spotify",
    platforms: ["spotify"],
  };
}

function appleTrackToEntity(track) {
  const artworkUrl = String(track.artworkUrl100 || "").replace("100x100bb", "512x512bb");

  return {
    id: String(track.trackId),
    type: "song",
    title: track.trackName,
    artistName: track.artistName,
    thumbnailUrl: artworkUrl || track.artworkUrl100,
    thumbnailWidth: artworkUrl ? 512 : 100,
    thumbnailHeight: artworkUrl ? 512 : 100,
    apiProvider: "itunes",
    platforms: ["appleMusic"],
  };
}

function checkClientRateLimit(key) {
  const now = Date.now();
  const existing = clientRateLimitStore.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : {
          count: 0,
          resetAt: now + CLIENT_WINDOW_MS,
        };

  bucket.count += 1;
  clientRateLimitStore.set(key, bucket);
  cleanupClientRateLimitStore(now);

  if (bucket.count > CLIENT_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterMs: Math.max(1000, bucket.resetAt - now),
    };
  }

  return { allowed: true, retryAfterMs: 0 };
}

function cleanupClientRateLimitStore(now) {
  if (clientRateLimitStore.size < 500) {
    return;
  }

  for (const [key, bucket] of clientRateLimitStore.entries()) {
    if (bucket.resetAt <= now) {
      clientRateLimitStore.delete(key);
    }
  }
}

function getClientRateLimitKey(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const firstForwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : String(forwardedFor || "").split(",")[0];
  const realIp = request.headers["x-real-ip"];
  const realIpValue = Array.isArray(realIp) ? realIp[0] : String(realIp || "");

  return (
    firstForwardedIp.trim() ||
    realIpValue.trim() ||
    request.socket?.remoteAddress ||
    "unknown"
  );
}

function getSpotifySearchCacheKey(target, userCountry) {
  return [
    userCountry,
    normalizeText(target.artistName),
    normalizeText(target.title),
    normalizeText(target.albumName),
    target.durationMs || "",
  ].join("|");
}

function getAppleMusicSearchCacheKey(target, userCountry) {
  return [
    userCountry,
    normalizeText(target.artistName),
    normalizeText(target.title),
    normalizeText(target.albumName),
    target.durationMs || "",
  ].join("|");
}

function readSpotifySearchCache(key) {
  const entry = spotifySearchCache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    spotifySearchCache.delete(key);
    return null;
  }

  return entry.tracks;
}

function writeSpotifySearchCache(key, tracks) {
  spotifySearchCache.set(key, {
    expiresAt: Date.now() + SPOTIFY_SEARCH_CACHE_TTL_MS,
    tracks,
  });

  if (spotifySearchCache.size <= SPOTIFY_SEARCH_CACHE_MAX) {
    return;
  }

  const oldestKey = spotifySearchCache.keys().next().value;

  if (oldestKey) {
    spotifySearchCache.delete(oldestKey);
  }
}

function readAppleMusicSearchCache(key) {
  const entry = appleMusicSearchCache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    appleMusicSearchCache.delete(key);
    return null;
  }

  return entry.tracks;
}

function writeAppleMusicSearchCache(key, tracks) {
  appleMusicSearchCache.set(key, {
    expiresAt: Date.now() + APPLE_MUSIC_SEARCH_CACHE_TTL_MS,
    tracks,
  });

  if (appleMusicSearchCache.size <= APPLE_MUSIC_SEARCH_CACHE_MAX) {
    return;
  }

  const oldestKey = appleMusicSearchCache.keys().next().value;

  if (oldestKey) {
    appleMusicSearchCache.delete(oldestKey);
  }
}

function spotifyRateLimitError(response) {
  const retryAfterSeconds = Math.max(1, Math.ceil(readRetryAfterMs(response) / 1000));
  const error = new Error("Spotify rate limit reached.");
  error.publicReason = "spotify_rate_limited";
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function readRetryAfterMs(response) {
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : 3000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAppleMetadata(appleUrl, userCountry) {
  const trackId = extractAppleTrackId(appleUrl);

  if (!trackId) {
    return {};
  }

  const endpoint = new URL(ITUNES_LOOKUP_ENDPOINT);
  endpoint.searchParams.set("id", trackId);
  endpoint.searchParams.set("country", userCountry);

  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return {};
    }

    const payload = await response.json();
    return payload.results?.find((result) => result.kind === "song") || {};
  } catch (error) {
    return {};
  }
}

function extractAppleTrackId(appleUrl) {
  try {
    const parsed = new URL(appleUrl);
    const queryTrackId = parsed.searchParams.get("i");

    if (/^\d+$/.test(queryTrackId || "")) {
      return queryTrackId;
    }

    return parsed.pathname
      .split("/")
      .reverse()
      .find((part) => /^\d+$/.test(part));
  } catch (error) {
    return "";
  }
}

function pickSourceEntity(payload) {
  const entities = payload.entitiesByUniqueId || {};
  return entities[payload.entityUniqueId] || Object.values(entities)[0] || {};
}

function normalizeMusicUrl(value) {
  if (typeof value !== "string") {
    return { url: "", platform: "" };
  }

  try {
    const parsed = new URL(value.trim());
    const hostname = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (
      hostname.endsWith("music.apple.com") ||
      hostname.endsWith("itunes.apple.com")
    ) {
      return { url: parsed.href, platform: "appleMusic" };
    }

    if (
      (hostname === "open.spotify.com" && pathParts.includes("track")) ||
      hostname === "spotify.link" ||
      hostname.endsWith(".spotify.link")
    ) {
      return { url: parsed.href, platform: "spotify" };
    }

    return { url: "", platform: "" };
  } catch (error) {
    return { url: "", platform: "" };
  }
}

function extractSpotifyTrackId(spotifyUrl) {
  try {
    const parsed = new URL(spotifyUrl);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const trackIndex = pathParts.indexOf("track");
    const trackId = pathParts[trackIndex + 1] || "";
    return /^[A-Za-z0-9]{16,32}$/.test(trackId) ? trackId : "";
  } catch (error) {
    return "";
  }
}

function normalizeCountry(value) {
  if (typeof value !== "string") {
    return DEFAULT_COUNTRY;
  }

  const country = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : DEFAULT_COUNTRY;
}
