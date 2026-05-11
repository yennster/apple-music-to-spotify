const API_BASE = "https://api.song.link/v1-alpha.1/links";
const PROXY_BASE = "/api/links";
const DEFAULT_COUNTRY = "US";

// Spotify OAuth PKCE apps expose the client ID in the browser. Never put the
// client secret in frontend code.
const SPOTIFY_CLIENT_ID = "9cf7de087bce4320829b07e6894bed75";
const SPOTIFY_AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const SPOTIFY_WEB_API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_PLAYER_NAME = "Apple Music to Spotify";
const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
];

const STORAGE_PREFIX = "apple-music-to-spotify:";
const AUTH_STATE_STORAGE_KEY = `${STORAGE_PREFIX}spotify-auth-state`;
const CODE_VERIFIER_STORAGE_KEY = `${STORAGE_PREFIX}spotify-code-verifier`;
const SPOTIFY_SESSION_STORAGE_KEY = `${STORAGE_PREFIX}spotify-session`;
const LAST_MATCH_STORAGE_KEY = `${STORAGE_PREFIX}last-match`;

const form = document.querySelector("#converter-form");
const appleUrlInput = document.querySelector("#apple-url");
const countryInput = document.querySelector("#user-country");
const convertButton = document.querySelector("#convert-button");
const pasteButton = document.querySelector("#paste-button");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const artworkEl = document.querySelector("#artwork");
const trackTitleEl = document.querySelector("#track-title");
const trackArtistEl = document.querySelector("#track-artist");
const spotifyUrlEl = document.querySelector("#spotify-url");
const copyButton = document.querySelector("#copy-button");
const openButton = document.querySelector("#open-button");
const bookmarkletLink = document.querySelector("#bookmarklet-link");
const copyBookmarkletButton = document.querySelector("#copy-bookmarklet-button");
const playerPanel = document.querySelector("#player-panel");
const playerTitleEl = document.querySelector("#player-title");
const playerStatusEl = document.querySelector("#player-status");
const spotifyConnectButton = document.querySelector("#spotify-connect-button");
const spotifyPlayButton = document.querySelector("#spotify-play-button");
const spotifyPauseButton = document.querySelector("#spotify-pause-button");
const spotifyDisconnectButton = document.querySelector("#spotify-disconnect-button");

let resolvedSpotifyUrl = "";
let resolvedLabel = "Spotify URL";
let currentSpotifyUri = "";
let spotifyPlayer = null;
let spotifyPlayerReadyPromise = null;
let spotifySdkPromise = null;
let spotifyDeviceId = "";
let spotifyPlaybackBusy = false;

const spotifyApiQueue = createQueuedRateLimiter(700);

const bookmarkletBody =
  '(async()=>{const h=location.hostname.toLowerCase();if(!h.endsWith("music.apple.com")&&!h.endsWith("itunes.apple.com")){alert("Open an Apple Music song page first.");return;}const e=new URL("https://music.jennyspeelman.dev/api/links");e.searchParams.set("url",location.href);e.searchParams.set("userCountry","US");const r=await fetch(e,{headers:{accept:"application/json"}});if(!r.ok)throw new Error("Songlink returned "+r.status);const d=await r.json();const s=d.linksByPlatform&&d.linksByPlatform.spotify&&d.linksByPlatform.spotify.url;const n=d.entitiesByUniqueId||{};const id=d.entityUniqueId;const a=n[id]||Object.values(n).find(x=>x&&x.type==="song")||{};const q=[a.artistName,a.title].filter(Boolean).join(" ").trim();const u=s||(q&&("https://open.spotify.com/search/"+encodeURIComponent(q)));if(!u){alert("No Spotify match found.");return;}try{await navigator.clipboard.writeText(u);alert("Copied "+(s?"Spotify URL":"Spotify search")+":\\n"+u);}catch(t){prompt(s?"Spotify URL":"Spotify search",u);}})().catch(e=>alert("Apple Music to Spotify failed: "+(e&&e.message?e.message:e)))';
const bookmarkletUrl = `javascript:${bookmarkletBody}`;

init();

async function init() {
  bookmarkletLink.href = bookmarkletUrl;

  form.addEventListener("submit", handleConvertSubmit);
  pasteButton.addEventListener("click", handlePaste);
  copyButton.addEventListener("click", handleCopyResult);
  copyBookmarkletButton.addEventListener("click", handleCopyBookmarklet);
  appleUrlInput.addEventListener("paste", handleAppleUrlPaste);
  spotifyConnectButton.addEventListener("click", handleSpotifyConnect);
  spotifyPlayButton.addEventListener("click", handleSpotifyPlay);
  spotifyPauseButton.addEventListener("click", handleSpotifyPause);
  spotifyDisconnectButton.addEventListener("click", handleSpotifyDisconnect);

  await completeSpotifyAuthRedirect();

  const incomingUrl = new URLSearchParams(window.location.search).get("url");

  if (incomingUrl) {
    appleUrlInput.value = incomingUrl;
    window.setTimeout(() => form.requestSubmit(), 0);
  } else {
    restoreLastMatch();
  }

  updateSpotifyPlaybackUi();
}

async function handleConvertSubmit(event) {
  event.preventDefault();

  let appleUrl;
  let country;

  try {
    appleUrl = normalizeAppleMusicUrl(appleUrlInput.value);
    country = normalizeCountry(countryInput.value);
    countryInput.value = country;
  } catch (error) {
    showError(error.message);
    return;
  }

  setBusy(true);
  setStatus("Finding the Spotify match...");
  resultEl.hidden = true;
  playerPanel.hidden = true;

  try {
    const match = await resolveSpotifyMatch(appleUrl, country);
    renderResult(match);

    try {
      await copyText(match.spotifyUrl);
      setStatus(`${resolvedLabel} copied.`, "success");
    } catch (copyError) {
      setStatus(`${resolvedLabel} ready. Press Copy to save it.`);
    }
  } catch (error) {
    showError(readableError(error));
  } finally {
    setBusy(false);
  }
}

async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    appleUrlInput.value = text.trim();
    appleUrlInput.focus();
  } catch (error) {
    showError("Clipboard access is blocked in this browser.");
  }
}

async function handleCopyResult() {
  if (!resolvedSpotifyUrl) return;

  try {
    await copyText(resolvedSpotifyUrl);
    setStatus(`${resolvedLabel} copied.`, "success");
  } catch (error) {
    showError("Copy failed. Select the link and copy it manually.");
  }
}

async function handleCopyBookmarklet() {
  try {
    await copyText(bookmarkletUrl);
    setStatus("Bookmarklet copied.", "success");
  } catch (error) {
    showError("Copy failed. Drag the bookmarklet link instead.");
  }
}

function handleAppleUrlPaste() {
  window.setTimeout(() => {
    if (looksLikeAppleMusicUrl(appleUrlInput.value)) {
      form.requestSubmit();
    }
  }, 0);
}

async function handleSpotifyConnect() {
  setSpotifyBusy(true);

  try {
    if (!hasSpotifySession()) {
      await startSpotifyAuth();
      return;
    }

    await ensureSpotifyPlayer();
    setSpotifyStatus("Spotify player connected.", "success");
  } catch (error) {
    setSpotifyStatus(readableSpotifyError(error), "error");
  } finally {
    setSpotifyBusy(false);
  }
}

async function handleSpotifyPlay() {
  if (!currentSpotifyUri) {
    setSpotifyStatus("Convert to a direct Spotify track first.", "error");
    return;
  }

  setSpotifyBusy(true);

  try {
    if (!hasSpotifySession()) {
      await startSpotifyAuth();
      return;
    }

    const player = await ensureSpotifyPlayer();

    if (typeof player.activateElement === "function") {
      await player.activateElement();
    }

    await spotifyApiFetch(`/me/player/play?device_id=${encodeURIComponent(spotifyDeviceId)}`, {
      method: "PUT",
      body: JSON.stringify({
        uris: [currentSpotifyUri],
        position_ms: 0,
      }),
    });
    setSpotifyStatus("Playing on this page.", "success");
  } catch (error) {
    setSpotifyStatus(readableSpotifyError(error), "error");
  } finally {
    setSpotifyBusy(false);
  }
}

async function handleSpotifyPause() {
  if (!spotifyPlayer) return;

  setSpotifyBusy(true);

  try {
    await spotifyPlayer.pause();
    setSpotifyStatus("Paused.", "neutral");
  } catch (error) {
    setSpotifyStatus(readableSpotifyError(error), "error");
  } finally {
    setSpotifyBusy(false);
  }
}

function handleSpotifyDisconnect() {
  clearSpotifySession();

  if (spotifyPlayer) {
    spotifyPlayer.disconnect();
  }

  spotifyPlayer = null;
  spotifyPlayerReadyPromise = null;
  spotifyDeviceId = "";
  setSpotifyStatus("Spotify disconnected.", "neutral");
  updateSpotifyPlaybackUi();
}

function normalizeAppleMusicUrl(value) {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Enter an Apple Music URL.");
  }

  let parsed;

  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error("That URL is not valid.");
  }

  if (!looksLikeAppleMusicUrl(parsed.href)) {
    throw new Error("Use a music.apple.com song link.");
  }

  return parsed.href;
}

function looksLikeAppleMusicUrl(value) {
  try {
    const parsed = new URL(value.trim());
    const hostname = parsed.hostname.toLowerCase();
    return hostname.endsWith("music.apple.com") || hostname.endsWith("itunes.apple.com");
  } catch (error) {
    return false;
  }
}

function normalizeCountry(value) {
  const normalized = value.trim().toUpperCase() || DEFAULT_COUNTRY;

  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error("Use a two-letter country code.");
  }

  return normalized;
}

async function resolveSpotifyMatch(appleUrl, country) {
  const endpoint = getLinksEndpoint();
  endpoint.searchParams.set("url", appleUrl);
  endpoint.searchParams.set("userCountry", country);

  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    const error = new Error(`Songlink returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  const entity = pickEntity(payload);
  const spotifyLink = payload.linksByPlatform?.spotify;
  const spotifyUrl = spotifyLink?.url;
  const spotifyUri = spotifyLink?.nativeAppUriDesktop || spotifyUrlToTrackUri(spotifyUrl);
  const fallbackUrl = spotifyUrl ? "" : buildSpotifySearchUrl(entity);

  return {
    spotifyUrl: spotifyUrl || fallbackUrl,
    spotifyUri,
    isDirect: Boolean(spotifyUrl),
    source: payload.spotifyMatch?.source || (spotifyUrl ? "songlink" : "search-fallback"),
    pageUrl: payload.pageUrl,
    entity,
  };
}

function getLinksEndpoint() {
  if (shouldUseProxy()) {
    return new URL(PROXY_BASE, window.location.origin);
  }

  return new URL(API_BASE);
}

function shouldUseProxy() {
  const hostname = window.location.hostname.toLowerCase();
  return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "";
}

function pickEntity(payload) {
  const entities = payload.entitiesByUniqueId ?? {};
  const spotifyEntityId = payload.linksByPlatform?.spotify?.entityUniqueId;
  const sourceEntityId = payload.entityUniqueId;

  return (
    entities[spotifyEntityId] ??
    entities[sourceEntityId] ??
    Object.values(entities).find((entity) => entity?.type === "song") ??
    {}
  );
}

function renderResult(match, options = {}) {
  const { entity, spotifyUrl, spotifyUri, isDirect, source } = match;
  resolvedSpotifyUrl = spotifyUrl;
  resolvedLabel = isDirect
    ? source === "spotify-search"
      ? "Spotify match"
      : "Spotify URL"
    : "Spotify search";

  const title = entity.title || "Spotify match";
  const artist = entity.artistName || "Artist unavailable";

  trackTitleEl.textContent = title;
  trackArtistEl.textContent = artist;
  document.querySelector("#result-title").textContent = resolvedLabel;
  spotifyUrlEl.href = spotifyUrl;
  spotifyUrlEl.textContent = spotifyUrl;
  openButton.href = spotifyUrl;

  if (entity.thumbnailUrl) {
    artworkEl.src = entity.thumbnailUrl;
    artworkEl.hidden = false;
    resultEl.classList.remove("without-artwork");
  } else {
    artworkEl.removeAttribute("src");
    artworkEl.hidden = true;
    resultEl.classList.add("without-artwork");
  }

  resultEl.hidden = false;
  renderSpotifyPlayback({
    ...match,
    spotifyUri: spotifyUri || spotifyUrlToTrackUri(spotifyUrl),
  });

  if (options.persist !== false) {
    saveLastMatch(match);
  }
}

function renderSpotifyPlayback(match) {
  currentSpotifyUri = match.isDirect ? match.spotifyUri || "" : "";

  if (!currentSpotifyUri) {
    playerPanel.hidden = true;
    updateSpotifyPlaybackUi();
    return;
  }

  const title = match.entity?.title || "this track";
  playerTitleEl.textContent = `Ready: ${title}`;
  playerPanel.hidden = false;
  updateSpotifyPlaybackUi();
}

function saveLastMatch(match) {
  try {
    sessionStorage.setItem(
      LAST_MATCH_STORAGE_KEY,
      JSON.stringify({
        spotifyUrl: match.spotifyUrl,
        spotifyUri: match.spotifyUri,
        isDirect: match.isDirect,
        source: match.source,
        pageUrl: match.pageUrl,
        entity: {
          title: match.entity?.title || "",
          artistName: match.entity?.artistName || "",
          thumbnailUrl: match.entity?.thumbnailUrl || "",
        },
      }),
    );
  } catch (error) {
    // Session storage is optional polish. The conversion flow works without it.
  }
}

function restoreLastMatch() {
  try {
    const serialized = sessionStorage.getItem(LAST_MATCH_STORAGE_KEY);

    if (!serialized) {
      return false;
    }

    const match = JSON.parse(serialized);

    if (!match?.spotifyUrl) {
      return false;
    }

    renderResult(match, { persist: false });
    return true;
  } catch (error) {
    sessionStorage.removeItem(LAST_MATCH_STORAGE_KEY);
    return false;
  }
}

function buildSpotifySearchUrl(entity) {
  const query = [entity.artistName, entity.title]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!query) {
    throw new Error("Songlink could not find enough track data for Spotify.");
  }

  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

function spotifyUrlToTrackUri(value) {
  if (!value) {
    return "";
  }

  if (/^spotify:track:[A-Za-z0-9]+$/.test(value)) {
    return value;
  }

  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const trackIndex = parts.indexOf("track");
    const trackId = parts[trackIndex + 1] || "";

    if (/^[A-Za-z0-9]{16,32}$/.test(trackId)) {
      return `spotify:track:${trackId}`;
    }
  } catch (error) {
    return "";
  }

  return "";
}

async function startSpotifyAuth() {
  if (!window.isSecureContext) {
    throw new Error("Spotify sign in needs HTTPS or localhost.");
  }

  const codeVerifier = generateRandomString(64);
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const state = generateRandomString(24);
  const authUrl = new URL(SPOTIFY_AUTH_ENDPOINT);

  sessionStorage.setItem(CODE_VERIFIER_STORAGE_KEY, codeVerifier);
  sessionStorage.setItem(AUTH_STATE_STORAGE_KEY, state);

  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES.join(" "),
    redirect_uri: getSpotifyRedirectUri(),
    state,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  }).toString();

  window.location.assign(authUrl.toString());
}

async function completeSpotifyAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");

  if (!code && !error) {
    return false;
  }

  if (error) {
    cleanupSpotifyAuthState();
    cleanupSpotifyAuthQuery();
    setStatus("Spotify sign in was cancelled.", "error");
    return true;
  }

  const state = params.get("state") || "";
  const expectedState = sessionStorage.getItem(AUTH_STATE_STORAGE_KEY) || "";
  const codeVerifier = sessionStorage.getItem(CODE_VERIFIER_STORAGE_KEY) || "";

  if (!state || state !== expectedState || !codeVerifier) {
    cleanupSpotifyAuthState();
    cleanupSpotifyAuthQuery();
    setStatus("Spotify sign in could not be verified.", "error");
    return true;
  }

  try {
    const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: getSpotifyRedirectUri(),
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      throw new Error("Spotify token exchange failed.");
    }

    storeSpotifySession(await response.json());
    cleanupSpotifyAuthState();
    cleanupSpotifyAuthQuery();
    setStatus("Spotify connected. Start the player when you are ready.", "success");
    return true;
  } catch (exchangeError) {
    cleanupSpotifyAuthState();
    cleanupSpotifyAuthQuery();
    setStatus("Spotify sign in failed. Check the redirect URI in the Spotify app.", "error");
    return true;
  }
}

function getSpotifyRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

function cleanupSpotifyAuthState() {
  sessionStorage.removeItem(AUTH_STATE_STORAGE_KEY);
  sessionStorage.removeItem(CODE_VERIFIER_STORAGE_KEY);
}

function cleanupSpotifyAuthQuery() {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("code");
  cleanUrl.searchParams.delete("state");
  cleanUrl.searchParams.delete("error");
  window.history.replaceState({}, document.title, `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}

function readSpotifySession() {
  try {
    const serialized = sessionStorage.getItem(SPOTIFY_SESSION_STORAGE_KEY);
    return serialized ? JSON.parse(serialized) : null;
  } catch (error) {
    clearSpotifySession();
    return null;
  }
}

function storeSpotifySession(payload) {
  const existing = readSpotifySession() || {};
  const expiresIn = Number(payload.expires_in || 3600);

  sessionStorage.setItem(
    SPOTIFY_SESSION_STORAGE_KEY,
    JSON.stringify({
      accessToken: payload.access_token || existing.accessToken || "",
      refreshToken: payload.refresh_token || existing.refreshToken || "",
      expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
    }),
  );
}

function clearSpotifySession() {
  sessionStorage.removeItem(SPOTIFY_SESSION_STORAGE_KEY);
}

function hasSpotifySession() {
  const session = readSpotifySession();
  return Boolean(session?.accessToken || session?.refreshToken);
}

async function ensureSpotifyAccessToken() {
  const session = readSpotifySession();

  if (session?.accessToken && session.expiresAt > Date.now() + 60000) {
    return session.accessToken;
  }

  if (session?.refreshToken) {
    return refreshSpotifyAccessToken(session.refreshToken);
  }

  await startSpotifyAuth();
  throw new Error("Spotify authorization started.");
}

async function refreshSpotifyAccessToken(refreshToken) {
  const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    clearSpotifySession();
    throw new Error("Spotify session expired.");
  }

  const payload = await response.json();
  storeSpotifySession(payload);
  return payload.access_token;
}

async function ensureSpotifyPlayer() {
  if (spotifyPlayer && spotifyDeviceId) {
    return spotifyPlayer;
  }

  await ensureSpotifyAccessToken();
  await loadSpotifySdk();

  if (!spotifyPlayer) {
    let readyTimeoutId = 0;
    let rejectReady;

    spotifyPlayerReadyPromise = new Promise((resolve, reject) => {
      rejectReady = reject;
      readyTimeoutId = window.setTimeout(() => {
        reject(new Error("Spotify player took too long to start."));
      }, 15000);

      const player = new window.Spotify.Player({
        name: SPOTIFY_PLAYER_NAME,
        getOAuthToken: (callback) => {
          ensureSpotifyAccessToken()
            .then((token) => callback(token))
            .catch(() => callback(""));
        },
        volume: 0.65,
        enableMediaSession: true,
      });

      player.addListener("ready", ({ device_id: deviceId }) => {
        window.clearTimeout(readyTimeoutId);
        spotifyDeviceId = deviceId;
        updateSpotifyPlaybackUi();
        resolve(deviceId);
      });

      player.addListener("not_ready", () => {
        spotifyDeviceId = "";
        updateSpotifyPlaybackUi();
      });

      player.addListener("player_state_changed", (state) => {
        if (!state) return;

        const currentTrack = state.track_window?.current_track;

        if (currentTrack?.name) {
          playerTitleEl.textContent = `Now: ${currentTrack.name}`;
        }

        if (state.paused) {
          setSpotifyStatus("Paused.", "neutral");
        } else {
          setSpotifyStatus("Playing on this page.", "success");
        }
      });

      player.addListener("initialization_error", ({ message }) => {
        reject(new Error(message || "Spotify player could not initialize."));
      });

      player.addListener("authentication_error", ({ message }) => {
        clearSpotifySession();
        reject(new Error(message || "Spotify authentication failed."));
      });

      player.addListener("account_error", () => {
        reject(new Error("Spotify Premium is required for browser playback."));
      });

      spotifyPlayer = player;
    });

    let connected = false;

    try {
      connected = await spotifyPlayer.connect();
    } catch (error) {
      rejectReady?.(error);
    }

    if (!connected) {
      rejectReady?.(new Error("Spotify player could not connect."));
    }
  }

  try {
    await spotifyPlayerReadyPromise;
  } catch (error) {
    if (spotifyPlayer) {
      spotifyPlayer.disconnect();
    }

    spotifyPlayer = null;
    spotifyPlayerReadyPromise = null;
    spotifyDeviceId = "";
    updateSpotifyPlaybackUi();
    throw error;
  }

  return spotifyPlayer;
}

function loadSpotifySdk() {
  if (window.Spotify?.Player) {
    return Promise.resolve();
  }

  if (spotifySdkPromise) {
    return spotifySdkPromise;
  }

  spotifySdkPromise = new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();

    if (document.querySelector("script[data-spotify-sdk]")) {
      return;
    }

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.dataset.spotifySdk = "true";
    script.onerror = () => reject(new Error("Spotify player script could not load."));
    document.body.append(script);
  });

  return spotifySdkPromise;
}

async function spotifyApiFetch(path, options = {}) {
  return spotifyApiQueue(async () => {
    let response = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await ensureSpotifyAccessToken();
      response = await fetch(`${SPOTIFY_WEB_API_BASE}${path}`, {
        ...options,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          ...(options.headers || {}),
        },
      });

      if (response.status === 429 && attempt === 0) {
        const retryAfterMs = readRetryAfterMs(response);
        setSpotifyStatus(`Spotify is pacing requests. Retrying in ${Math.ceil(retryAfterMs / 1000)}s.`);
        await delay(retryAfterMs);
        continue;
      }

      if (response.status === 401 && attempt === 0) {
        const session = readSpotifySession();

        if (session?.refreshToken) {
          await refreshSpotifyAccessToken(session.refreshToken);
          continue;
        }
      }

      break;
    }

    if (!response?.ok) {
      throw new Error(await readSpotifyApiError(response));
    }

    return response;
  });
}

function updateSpotifyPlaybackUi() {
  const hasSession = hasSpotifySession();

  spotifyDisconnectButton.hidden = !hasSession;
  spotifyConnectButton.disabled = spotifyPlaybackBusy || Boolean(spotifyDeviceId);
  spotifyPlayButton.disabled = spotifyPlaybackBusy || !currentSpotifyUri || !spotifyDeviceId;
  spotifyPauseButton.disabled = spotifyPlaybackBusy || !spotifyPlayer || !spotifyDeviceId;

  if (!currentSpotifyUri) {
    spotifyConnectButton.textContent = hasSession ? "Start player" : "Connect";
    return;
  }

  if (spotifyPlaybackBusy) {
    spotifyConnectButton.textContent = spotifyDeviceId ? "Connected" : "Starting...";
    return;
  }

  if (!hasSession) {
    spotifyConnectButton.textContent = "Connect";
    setSpotifyStatus("Connect a Spotify Premium account to use browser playback.");
    return;
  }

  if (!spotifyDeviceId) {
    spotifyConnectButton.textContent = "Start player";
    setSpotifyStatus("Account connected. Start the player to play this track.");
    return;
  }

  spotifyConnectButton.textContent = "Connected";
  setSpotifyStatus("Ready to play on this page.", "success");
}

function setSpotifyBusy(isBusy) {
  spotifyPlaybackBusy = isBusy;
  updateSpotifyPlaybackUi();
}

function setSpotifyStatus(message, tone = "neutral") {
  playerStatusEl.textContent = message;
  playerStatusEl.dataset.tone = tone;
}

async function readSpotifyApiError(response) {
  if (!response) {
    return "Spotify request failed.";
  }

  if (response.status === 403) {
    return "Spotify Premium is required for browser playback.";
  }

  if (response.status === 429) {
    return "Spotify rate limit reached. Wait a moment and try again.";
  }

  try {
    const payload = await response.json();
    return payload.error?.message || payload.error_description || "Spotify request failed.";
  } catch (error) {
    return "Spotify request failed.";
  }
}

function readableSpotifyError(error) {
  const message = error?.message || "Spotify playback failed.";

  if (message.includes("authorization started")) {
    return "Finish Spotify sign in to continue.";
  }

  if (message.toLowerCase().includes("premium")) {
    return "Spotify Premium is required for browser playback.";
  }

  if (message.toLowerCase().includes("rate limit")) {
    return "Spotify rate limit reached. Wait a moment and try again.";
  }

  return message;
}

async function createCodeChallenge(codeVerifier) {
  const bytes = new TextEncoder().encode(codeVerifier);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function generateRandomString(length) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = window.crypto.getRandomValues(new Uint8Array(length));
  return [...values].map((value) => possible[value % possible.length]).join("");
}

function createQueuedRateLimiter(minIntervalMs) {
  let chain = Promise.resolve();
  let nextRunAt = 0;

  return (task) => {
    const run = chain
      .catch(() => {})
      .then(async () => {
        const waitMs = Math.max(0, nextRunAt - Date.now());

        if (waitMs) {
          await delay(waitMs);
        }

        nextRunAt = Date.now() + minIntervalMs;
        return task();
      });

    chain = run.catch(() => {});
    return run;
  };
}

function readRetryAfterMs(response) {
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : 3000;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.inset = "0 auto auto 0";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();

  const didCopy = document.execCommand("copy");
  textArea.remove();

  if (!didCopy) {
    throw new Error("Copy command failed.");
  }
}

function setBusy(isBusy) {
  convertButton.disabled = isBusy;
  convertButton.textContent = isBusy ? "Finding..." : "Convert";
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function showError(message) {
  setStatus(message, "error");
}

function readableError(error) {
  if (error?.status === 429) {
    return "Rate limit reached. Wait a minute and try again.";
  }

  return error?.message || "Something went wrong.";
}
