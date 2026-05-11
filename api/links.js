const SONGLINK_ENDPOINT = "https://api.song.link/v1-alpha.1/links";
const DEFAULT_COUNTRY = "US";

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

  const endpoint = new URL(SONGLINK_ENDPOINT);
  endpoint.searchParams.set("url", appleUrl);
  endpoint.searchParams.set("userCountry", userCountry);

  try {
    const songlinkResponse = await fetch(endpoint, {
      headers: {
        accept: "application/json",
      },
    });

    const body = await songlinkResponse.text();
    response.status(songlinkResponse.status);
    response.setHeader(
      "Content-Type",
      songlinkResponse.headers.get("content-type") || "application/json",
    );
    response.send(body);
  } catch (error) {
    response.status(502).json({ error: "Songlink request failed." });
  }
};

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
