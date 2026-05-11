const SONGLINK_ENDPOINT = "https://api.song.link/v1-alpha.1/links";
const ITUNES_LOOKUP_ENDPOINT = "https://itunes.apple.com/lookup";
const SPOTIFY_TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_ENDPOINT = "https://api.spotify.com/v1/search";
const DEFAULT_COUNTRY = "US";
const MIN_SPOTIFY_SCORE = 0.78;

let spotifyTokenCache = {
  accessToken: "",
  expiresAt: 0,
};

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

  const appleUrl = normalizeAppleMusicUrl(request.query.url);
  const userCountry = normalizeCountry(request.query.userCountry);

  if (!appleUrl) {
    response.status(400).json({ error: "Use a music.apple.com song link." });
    return;
  }

  try {
    const songlinkResponse = await fetchSonglinkPayload(appleUrl, userCountry);
    const payload = songlinkResponse.payload;

    if (!songlinkResponse.ok) {
      response.status(songlinkResponse.status).json(payload);
      return;
    }

    if (!payload.linksByPlatform?.spotify?.url) {
      try {
        await attachSpotifySearchMatch(payload, appleUrl, userCountry);
      } catch (spotifyError) {
        payload.spotifyMatch = {
          source: "search-fallback",
          reason: "spotify_lookup_failed",
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

async function searchSpotifyTracks(token, target, userCountry) {
  const queries = buildSpotifyQueries(target);
  const seen = new Set();
  const tracks = [];

  for (const query of queries) {
    const endpoint = new URL(SPOTIFY_SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("type", "track");
    endpoint.searchParams.set("market", userCountry);
    endpoint.searchParams.set("limit", "10");

    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });

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

function findBestSpotifyTrack(candidates, target) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreSpotifyTrack(candidate.track, target),
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

function normalizeAppleMusicUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  try {
    const parsed = new URL(value.trim());
    const hostname = parsed.hostname.toLowerCase();

    if (
      !hostname.endsWith("music.apple.com") &&
      !hostname.endsWith("itunes.apple.com")
    ) {
      return "";
    }

    return parsed.href;
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
