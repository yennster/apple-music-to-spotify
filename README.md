# Music Link Handoff

A small browser tool for turning Apple Music song URLs into Spotify URLs, and Spotify track URLs back into Apple Music URLs.

## Use it

Start a static server from this folder:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`, choose the direction and music-availability country if needed, paste a song link, and run the conversion. When a direct match is found, the app copies the destination URL and shows the link on screen. If Songlink does not return an exact destination link, the app copies a search URL using the resolved title and artist.

Direct Spotify track matches can also be played in the page through Spotify's Web Playback SDK. Browser playback requires a Spotify Premium account and a Spotify app redirect URI that exactly matches the page URL:

```text
http://localhost:8000/
https://music.jennyspeelman.dev/
```

In Spotify Developer Dashboard development mode, add each friend who should be able to sign in under User Management.

The `Bookmarklet` link in the app can be dragged to the bookmarks bar. It follows the selected direction, so use the Apple to Spotify bookmarklet on Apple Music pages and the Spotify to Apple bookmarklet on Spotify track pages.

## How it works

The app calls Songlink/Odesli's public links endpoint:

```text
https://api.song.link/v1-alpha.1/links?url=<MUSIC_URL>&userCountry=US
```

It then reads the target platform URL from `linksByPlatform`. When that field is missing, it uses the song metadata in `entitiesByUniqueId` to build a target-platform search URL.

In production, the browser calls the same-origin Vercel function at `/api/links`, which proxies Songlink and avoids third-party CORS restrictions. Localhost uses Songlink directly.

If Songlink does not return a Spotify URL for Apple to Spotify, the Vercel function can optionally query Spotify's Search API and attach a high-confidence track match before the browser falls back to a search URL. Configure these production environment variables to enable it:

```sh
vercel env add SPOTIFY_CLIENT_ID production
vercel env add SPOTIFY_CLIENT_SECRET production
vercel --prod
```

The client ID is safe to expose for the browser PKCE flow. The client secret must only live in Vercel environment variables. If the secret has ever been shared in a screenshot or chat, rotate it in Spotify before adding it to Vercel.

For Spotify to Apple, the Vercel function uses Songlink first, then falls back to iTunes Search for a high-confidence Apple Music song URL.

## Notes

- Country defaults to United States; change the dropdown if music availability should be resolved elsewhere.
- Songlink may not find every direct destination URL, especially when regional catalogs differ.
- The Vercel function rate-limits conversion requests per client, throttles Spotify search calls, caches repeated Spotify searches for six hours, and respects Spotify's `Retry-After` response when Spotify returns `429`.
- Browser playback also queues Spotify Web API control calls so repeated button presses do not burst the API.
