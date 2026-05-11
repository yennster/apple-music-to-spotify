const API_BASE = "https://api.song.link/v1-alpha.1/links";
const PROXY_BASE = "/api/links";
const DEFAULT_COUNTRY = "US";
const DEFAULT_ROUTE = "apple-to-spotify";

const ROUTE_CONFIG = {
  "apple-to-spotify": {
    sourcePlatform: "appleMusic",
    targetPlatform: "spotify",
    sourceName: "Apple Music",
    sourceShortName: "Apple",
    targetName: "Spotify",
    sourceLabel: "Apple Music URL",
    placeholder: "https://music.apple.com/...",
    directLabel: "Spotify URL",
    matchLabel: "Spotify match",
    searchLabel: "Spotify search",
    findingStatus: "Finding the Spotify match...",
    sourceError: "Use a music.apple.com song link.",
  },
  "spotify-to-apple": {
    sourcePlatform: "spotify",
    targetPlatform: "appleMusic",
    sourceName: "Spotify",
    sourceShortName: "Spotify",
    targetName: "Apple Music",
    sourceLabel: "Spotify URL",
    placeholder: "https://open.spotify.com/track/...",
    directLabel: "Apple Music URL",
    matchLabel: "Apple Music match",
    searchLabel: "Apple Music search",
    findingStatus: "Finding the Apple Music match...",
    sourceError: "Use an open.spotify.com track link.",
  },
};

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
const titleSourceEl = document.querySelector("#title-source");
const titleTargetEl = document.querySelector("#title-target");
const routeChipSourceEl = document.querySelector("#route-chip-source");
const routeChipTargetEl = document.querySelector("#route-chip-target");
let currentRouteKey = DEFAULT_ROUTE; // will be updated by URL detection
const sourceUrlLabel = document.querySelector("#source-url-label");
const sourceUrlInput = document.querySelector("#source-url");
const countryInput = document.querySelector("#user-country");
const convertButton = document.querySelector("#convert-button");
const pasteButton = document.querySelector("#paste-button");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const artworkEl = document.querySelector("#artwork");
const trackTitleEl = document.querySelector("#track-title");
const trackArtistEl = document.querySelector("#track-artist");
const resultUrlEl = document.querySelector("#result-url");
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

let resolvedResultUrl = "";
let resolvedNativeUri = "";
let resolvedLabel = "Spotify URL";
let currentSpotifyUri = "";
let spotifyPlayer = null;
let spotifyPlayerReadyPromise = null;
let spotifySdkPromise = null;
let spotifyDeviceId = "";
let spotifyPlaybackBusy = false;

const spotifyApiQueue = createQueuedRateLimiter(700);

let bookmarkletUrl = "";

init();

async function init() {
  form.addEventListener("submit", handleConvertSubmit);
  pasteButton.addEventListener("click", handlePaste);
  copyButton.addEventListener("click", handleCopyResult);
  copyBookmarkletButton.addEventListener("click", handleCopyBookmarklet);
  sourceUrlInput.addEventListener("paste", handleSourceUrlPaste);
  sourceUrlInput.addEventListener("input", handleSourceUrlInput);
  // direction tabs removed — route is determined automatically from the URL
  openButton.addEventListener("click", handleOpenClick);
  spotifyConnectButton.addEventListener("click", handleSpotifyConnect);
  spotifyPlayButton.addEventListener("click", handleSpotifyPlay);
  spotifyPauseButton.addEventListener("click", handleSpotifyPause);
  spotifyDisconnectButton.addEventListener("click", handleSpotifyDisconnect);

  await completeSpotifyAuthRedirect();

  const incomingUrl = new URLSearchParams(window.location.search).get("url");

  if (incomingUrl) {
    sourceUrlInput.value = incomingUrl;
    window.setTimeout(() => form.requestSubmit(), 0);
  } else {
    restoreLastMatch();
  }

  updateRouteUi();
  updateSpotifyPlaybackUi();
  randomizeBubbles();
}

async function handleConvertSubmit(event) {
  event.preventDefault();

  let sourceUrl;
  let country;
  let routeKey = getCurrentRouteKey();

  try {
    const detectedRoute = detectRouteForUrl(sourceUrlInput.value);
    console.debug("handleConvertSubmit detectRouteForUrl ->", sourceUrlInput.value, detectedRoute);

    if (detectedRoute && detectedRoute !== routeKey) {
      setCurrentRoute(detectedRoute);
      routeKey = detectedRoute;
    }

    sourceUrl = normalizeSourceUrl(sourceUrlInput.value, routeKey);
    country = normalizeCountry(countryInput.value);
    countryInput.value = country;
  } catch (error) {
    showError(error.message);
    return;
  }

  setBusy(true);
  setStatus(ROUTE_CONFIG[routeKey].findingStatus);
  resultEl.hidden = true;
  playerPanel.hidden = true;

  try {
    const match = await resolveMusicMatch(sourceUrl, country, routeKey);
    renderResult(match);

    try {
      await copyText(match.resultUrl);
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
    sourceUrlInput.value = text.trim();
    maybeSwitchRouteForUrl(sourceUrlInput.value);
    sourceUrlInput.focus();
  } catch (error) {
    showError("Clipboard access is blocked in this browser.");
  }
}

async function handleCopyResult() {
  if (!resolvedResultUrl) return;

  try {
    await copyText(resolvedResultUrl);
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

function handleRouteChange() {
  updateRouteUi({ clearStatus: true, hideResult: true });
}

function handleSourceUrlPaste() {
  window.setTimeout(() => {
    const routeKey = maybeSwitchRouteForUrl(sourceUrlInput.value);

    if (routeKey) {
      form.requestSubmit();
    }
  }, 0);
}

let detectUrlDebounceTimer = 0;
function handleSourceUrlInput() {
  clearTimeout(detectUrlDebounceTimer);
  detectUrlDebounceTimer = window.setTimeout(() => {
    const val = sourceUrlInput.value;
    const detected = detectRouteForUrl(val);
    console.debug("detectRouteForUrl ->", val, detected);

    if (detected && detected !== getCurrentRouteKey()) {
      setCurrentRoute(detected);
      setStatus(`${ROUTE_CONFIG[detected].sourceName} detected`, "success");
      // clear status after a short delay so users see feedback
      window.setTimeout(() => setStatus(""), 1400);
    }
  }, 350);
}

// Randomize bubble positions, sizes and animation timings for a playful effect
function randomizeBubbles() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const container = document.querySelector('.title-bubbles');
    if (!container) return;
    const bubbles = Array.from(container.querySelectorAll('.bubble'));

    bubbles.forEach((b, i) => {
      // spread left 2%..94%
      const left = 2 + Math.random() * 92;
      // size 18..64px
      const size = Math.round(18 + Math.random() * 46);
      // small staggered delay
      const delay = (Math.random() * 2).toFixed(2) + 's';
      // variable durations
      const rise = (3.6 + Math.random() * 3.2).toFixed(2) + 's';
      const wobble = (3.8 + Math.random() * 3.6).toFixed(2) + 's';
      b.style.left = left + '%';
      b.style.width = size + 'px';
      b.style.height = size + 'px';
      b.style.animation = `bubble-rise ${rise} var(--fast-out) ${delay} infinite, bubble-wobble ${wobble} ease-in-out ${delay} infinite`;
      b.style.opacity = (0.85 + Math.random() * 0.15).toFixed(2);
      b.style.bottom = `${6 + Math.round(Math.random() * 18)}px`;
      b.style.transform = `translateZ(0)`;
    });
  } catch (e) {
    console.debug('randomizeBubbles failed', e);
  }
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

function handleOpenClick(event) {
  // Try native app URI first, then fall back to the web URL
  event.preventDefault();

  const nativeUri = resolvedNativeUri;
  const webUrl = resolvedResultUrl || openButton.href;

  if (nativeUri) {
    // attempt to open native URI via an iframe to avoid leaving the page immediately
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = nativeUri;
    document.body.appendChild(iframe);

    // fallback to web URL after short delay
    window.setTimeout(() => {
      // clean up iframe
      try {
        document.body.removeChild(iframe);
      } catch (e) {}
      window.open(webUrl, "_blank");
    }, 700);
  } else {
    // no native URI available — open web URL directly
    window.open(webUrl, "_blank");
  }
}

function normalizeSourceUrl(value, routeKey) {
  const config = ROUTE_CONFIG[routeKey] || ROUTE_CONFIG[DEFAULT_ROUTE];
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`Enter a ${config.sourceLabel}.`);
  }

  let parsed;

  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error("That URL is not valid.");
  }

  if (!looksLikePlatformUrl(parsed.href, config.sourcePlatform)) {
    throw new Error(config.sourceError);
  }

  return parsed.href;
}

function looksLikePlatformUrl(value, platform) {
  return platform === "spotify" ? looksLikeSpotifyUrl(value) : looksLikeAppleMusicUrl(value);
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

function looksLikeSpotifyUrl(value) {
  try {
    const trimmed = String(value || "").trim();

    // spotify URI form: spotify:track:ID
    if (/^spotify:track:[A-Za-z0-9]+$/i.test(trimmed)) return true;

    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    const knownHosts = [
      "open.spotify.com",
      "play.spotify.com",
      "spotify.link",
      "spoti.fi",
    ];

    if (knownHosts.includes(hostname) || hostname.endsWith(".spotify.link") || hostname.includes("spotify")) {
      // If it's a Spotify host and the path contains a track id, accept it.
      if (pathParts.includes("track") || /\btrack\b/.test(parsed.pathname)) return true;
      // short links sometimes redirect; accept known short hostnames as Spotify.
      if (hostname === "spoti.fi" || hostname === "spotify.link") return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

function detectRouteForUrl(value) {
  const v = String(value || "").trim();

  if (!v) return "";

  // quick substring checks (catch share links and non-URL forms)
  const lower = v.toLowerCase();

  if (lower.includes("music.apple.com") || lower.includes("itunes.apple.com") || lower.includes("applemusic")) {
    return "apple-to-spotify";
  }

  if (
    lower.includes("open.spotify.com") ||
    lower.includes("spotify.link") ||
    lower.includes("spoti.fi") ||
    lower.startsWith("spotify:") ||
    lower.includes("spotify")
  ) {
    return "spotify-to-apple";
  }

  // try parsing as URL and falling back to the more precise checks
  try {
    const parsed = new URL(v);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname.includes("music.apple.com") || hostname.includes("itunes.apple.com")) {
      return "apple-to-spotify";
    }

    if (
      hostname.includes("spotify") ||
      hostname === "spoti.fi" ||
      hostname.endsWith(".spotify.link")
    ) {
      return "spotify-to-apple";
    }
  } catch (e) {
    // ignore parse errors
  }

  return "";
}

function maybeSwitchRouteForUrl(value) {
  const detectedRoute = detectRouteForUrl(value);

  if (detectedRoute && detectedRoute !== getCurrentRouteKey()) {
    setCurrentRoute(detectedRoute);
  }

  return detectedRoute;
}

function getCurrentRouteKey() {
  return currentRouteKey || DEFAULT_ROUTE;
}

function setCurrentRoute(routeKey) {
  currentRouteKey = ROUTE_CONFIG[routeKey] ? routeKey : DEFAULT_ROUTE;
  updateRouteUi({ hideResult: true });
}

function updateRouteUi(options = {}) {
  const routeKey = getCurrentRouteKey();
  const config = ROUTE_CONFIG[routeKey];

  titleSourceEl.textContent = config.sourceName;
  titleTargetEl.textContent = `to ${config.targetName}`;
  routeChipSourceEl.textContent = config.sourceShortName;
  routeChipTargetEl.textContent = config.targetName.replace(" Music", "");
  sourceUrlLabel.textContent = config.sourceLabel;
  sourceUrlInput.placeholder = config.placeholder;
  bookmarkletUrl = buildBookmarkletUrl(routeKey);
  bookmarkletLink.href = bookmarkletUrl;

  if (options.clearStatus) {
    setStatus("");
  }

  if (options.hideResult) {
    resolvedResultUrl = "";
    currentSpotifyUri = "";
    resultEl.hidden = true;
    playerPanel.hidden = true;
    updateSpotifyPlaybackUi();
  }
}

function normalizeCountry(value) {
  const normalized = value.trim().toUpperCase() || DEFAULT_COUNTRY;

  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error("Use a two-letter country code.");
  }

  return normalized;
}

async function resolveMusicMatch(sourceUrl, country, routeKey) {
  const config = ROUTE_CONFIG[routeKey];
  const endpoint = getLinksEndpoint();
  endpoint.searchParams.set("url", sourceUrl);
  endpoint.searchParams.set("userCountry", country);
  endpoint.searchParams.set("direction", routeKey);

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
  const entity = pickEntity(payload, config.targetPlatform);
  const sourceEntity = pickEntity(payload, config.sourcePlatform);
  const targetLink = payload.linksByPlatform?.[config.targetPlatform];
  const sourceSpotifyLink = payload.linksByPlatform?.spotify;
  const resultUrl = targetLink?.url;
  const fallbackUrl = resultUrl
    ? ""
    : buildFallbackSearchUrl(entity, config.targetPlatform, country);
  const spotifyUri =
    config.targetPlatform === "spotify"
      ? targetLink?.nativeAppUriDesktop || spotifyUrlToTrackUri(resultUrl)
      : sourceSpotifyLink?.nativeAppUriDesktop || spotifyUrlToTrackUri(sourceUrl);

  // try to find a native app uri for the target platform (if Songlink provides it)
  const nativeAppUri = targetLink?.nativeAppUriDesktop || (config.targetPlatform === "spotify" ? spotifyUri : "");
  const targetMatch = payload.spotifyMatch || payload.appleMusicMatch || {};

  return {
    routeKey,
    resultUrl: resultUrl || fallbackUrl,
    spotifyUri,
    nativeAppUri,
    isDirect: Boolean(resultUrl),
    source: targetMatch.source || (resultUrl ? "songlink" : "search-fallback"),
    pageUrl: payload.pageUrl,
    targetPlatform: config.targetPlatform,
    sourcePlatform: config.sourcePlatform,
    entity: Object.keys(entity).length ? entity : sourceEntity,
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

function pickEntity(payload, platform) {
  const entities = payload.entitiesByUniqueId ?? {};
  const platformEntityId = payload.linksByPlatform?.[platform]?.entityUniqueId;
  const sourceEntityId = payload.entityUniqueId;

  return (
    entities[platformEntityId] ??
    entities[sourceEntityId] ??
    Object.values(entities).find((entity) => entity?.type === "song") ??
    {}
  );
}

function renderResult(match, options = {}) {
  const config = ROUTE_CONFIG[match.routeKey] || ROUTE_CONFIG[DEFAULT_ROUTE];
  const { entity, resultUrl, spotifyUri, nativeAppUri, isDirect, source, targetPlatform } = match;
  resolvedResultUrl = resultUrl;
  resolvedNativeUri = nativeAppUri || "";
  resolvedLabel = isDirect
    ? source === "spotify-search" || source === "itunes-search"
      ? config.matchLabel
      : config.directLabel
    : config.searchLabel;

  const title = entity.title || `${config.targetName} match`;
  const artist = entity.artistName || "Artist unavailable";

  trackTitleEl.textContent = title;
  trackArtistEl.textContent = artist;
  document.querySelector("#result-title").textContent = resolvedLabel;
  resultUrlEl.href = resultUrl;
  resultUrlEl.textContent = resultUrl;
  // openButton href remains the web fallback; click handler will try native app first
  openButton.href = resultUrl;
  resultEl.dataset.target = targetPlatform;

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
    spotifyUri: spotifyUri || spotifyUrlToTrackUri(resultUrl),
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
        routeKey: match.routeKey,
        resultUrl: match.resultUrl,
        spotifyUri: match.spotifyUri,
        isDirect: match.isDirect,
        source: match.source,
        pageUrl: match.pageUrl,
        targetPlatform: match.targetPlatform,
        sourcePlatform: match.sourcePlatform,
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

    if (!match?.resultUrl) {
      return false;
    }

    if (match.routeKey) {
      setCurrentRoute(match.routeKey);
    }

    renderResult(match, { persist: false });
    return true;
  } catch (error) {
    sessionStorage.removeItem(LAST_MATCH_STORAGE_KEY);
    return false;
  }
}

function buildFallbackSearchUrl(entity, targetPlatform, country = DEFAULT_COUNTRY) {
  const query = [entity.artistName, entity.title]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!query) {
    throw new Error("Songlink could not find enough track data for a search fallback.");
  }

  if (targetPlatform === "appleMusic") {
    return `https://music.apple.com/${country.toLowerCase()}/search?term=${encodeURIComponent(query)}`;
  }

  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

function buildBookmarkletUrl(routeKey) {
  const config = ROUTE_CONFIG[routeKey] || ROUTE_CONFIG[DEFAULT_ROUTE];
  const sourceHosts =
    config.sourcePlatform === "spotify"
      ? ["open.spotify.com", "spotify.link"]
      : ["music.apple.com", "itunes.apple.com"];
  const targetPlatform = config.targetPlatform;
  const directLabel = config.directLabel;
  const searchLabel = config.searchLabel;
  const failureMessage = `Open a ${config.sourceName} song page first.`;
  const searchPrefix =
    targetPlatform === "spotify"
      ? "https://open.spotify.com/search/"
      : "https://music.apple.com/search?term=";
  const hostCheck = `const ok=${JSON.stringify(
    sourceHosts,
  )}.some(x=>h===x||h.endsWith("."+x));`;
  const body =
    `(async()=>{const h=location.hostname.toLowerCase();${hostCheck}` +
    `if(!ok){alert(${JSON.stringify(failureMessage)});return;}` +
    'const e=new URL("https://music.jennyspeelman.dev/api/links");' +
    'e.searchParams.set("url",location.href);e.searchParams.set("userCountry","US");' +
    'const r=await fetch(e,{headers:{accept:"application/json"}});' +
    'if(!r.ok)throw new Error("Songlink returned "+r.status);' +
    `const d=await r.json();const l=d.linksByPlatform&&d.linksByPlatform[${JSON.stringify(
      targetPlatform,
    )}]&&d.linksByPlatform[${JSON.stringify(targetPlatform)}].url;` +
    'const n=d.entitiesByUniqueId||{};const id=d.entityUniqueId;' +
    'const a=n[id]||Object.values(n).find(x=>x&&x.type==="song")||{};' +
    'const q=[a.artistName,a.title].filter(Boolean).join(" ").trim();' +
    `const u=l||(q&&(${JSON.stringify(searchPrefix)}+encodeURIComponent(q)));` +
    `if(!u){alert("No ${config.targetName} match found.");return;}` +
    `try{await navigator.clipboard.writeText(u);alert("Copied "+(l?${JSON.stringify(
      directLabel,
    )}:${JSON.stringify(searchLabel)})+":\\n"+u);}` +
    `catch(t){prompt(l?${JSON.stringify(directLabel)}:${JSON.stringify(searchLabel)},u);}})()` +
    '.catch(e=>alert("Music link handoff failed: "+(e&&e.message?e.message:e)))';

  return `javascript:${body}`;
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
