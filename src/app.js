const API_BASE = "https://api.song.link/v1-alpha.1/links";
const DEFAULT_COUNTRY = "US";

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

let resolvedSpotifyUrl = "";
let resolvedLabel = "Spotify URL";

const bookmarkletBody =
  '(async()=>{const h=location.hostname.toLowerCase();if(!h.endsWith("music.apple.com")&&!h.endsWith("itunes.apple.com")){alert("Open an Apple Music song page first.");return;}const e=new URL("https://api.song.link/v1-alpha.1/links");e.searchParams.set("url",location.href);e.searchParams.set("userCountry","US");const r=await fetch(e,{headers:{accept:"application/json"}});if(!r.ok)throw new Error("Songlink returned "+r.status);const d=await r.json();const s=d.linksByPlatform&&d.linksByPlatform.spotify&&d.linksByPlatform.spotify.url;const n=d.entitiesByUniqueId||{};const id=d.entityUniqueId;const a=n[id]||Object.values(n).find(x=>x&&x.type==="song")||{};const q=[a.artistName,a.title].filter(Boolean).join(" ").trim();const u=s||(q&&("https://open.spotify.com/search/"+encodeURIComponent(q)));if(!u){alert("No Spotify match found.");return;}try{await navigator.clipboard.writeText(u);alert("Copied "+(s?"Spotify URL":"Spotify search")+":\\n"+u);}catch(t){prompt(s?"Spotify URL":"Spotify search",u);}})().catch(e=>alert("Apple Music to Spotify failed: "+(e&&e.message?e.message:e)))';
const bookmarkletUrl = `javascript:${bookmarkletBody}`;

bookmarkletLink.href = bookmarkletUrl;

form.addEventListener("submit", async (event) => {
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
});

pasteButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    appleUrlInput.value = text.trim();
    appleUrlInput.focus();
  } catch (error) {
    showError("Clipboard access is blocked in this browser.");
  }
});

copyButton.addEventListener("click", async () => {
  if (!resolvedSpotifyUrl) return;

  try {
    await copyText(resolvedSpotifyUrl);
    setStatus(`${resolvedLabel} copied.`, "success");
  } catch (error) {
    showError("Copy failed. Select the link and copy it manually.");
  }
});

copyBookmarkletButton.addEventListener("click", async () => {
  try {
    await copyText(bookmarkletUrl);
    setStatus("Bookmarklet copied.", "success");
  } catch (error) {
    showError("Copy failed. Drag the bookmarklet link instead.");
  }
});

appleUrlInput.addEventListener("paste", () => {
  window.setTimeout(() => {
    if (looksLikeAppleMusicUrl(appleUrlInput.value)) {
      form.requestSubmit();
    }
  }, 0);
});

countryInput.addEventListener("input", () => {
  countryInput.value = countryInput.value.toUpperCase();
});

const incomingUrl = new URLSearchParams(window.location.search).get("url");

if (incomingUrl) {
  appleUrlInput.value = incomingUrl;
  window.setTimeout(() => form.requestSubmit(), 0);
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
  const endpoint = new URL(API_BASE);
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
  const spotifyUrl = payload.linksByPlatform?.spotify?.url;
  const fallbackUrl = spotifyUrl ? "" : buildSpotifySearchUrl(entity);

  return {
    spotifyUrl: spotifyUrl || fallbackUrl,
    isDirect: Boolean(spotifyUrl),
    pageUrl: payload.pageUrl,
    entity,
  };
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

function renderResult(match) {
  const { entity, spotifyUrl, isDirect } = match;
  resolvedSpotifyUrl = spotifyUrl;
  resolvedLabel = isDirect ? "Spotify URL" : "Spotify search";

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
  } else {
    artworkEl.removeAttribute("src");
    artworkEl.hidden = true;
  }

  resultEl.hidden = false;
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
    return "Songlink rate limit reached. Wait a minute and try again.";
  }

  return error?.message || "Something went wrong.";
}
