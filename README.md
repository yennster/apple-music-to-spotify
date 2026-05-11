# Apple Music to Spotify

A small browser tool for turning an Apple Music song URL into the matching Spotify URL.

## Use it

Start a static server from this folder:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`, choose the music-availability country if needed, paste an Apple Music song link, and run the conversion. When a Spotify match is found, the app copies the Spotify URL and shows the link on screen. If Songlink does not return an exact Spotify link, the app copies a Spotify search URL using the resolved title and artist.

The `Bookmarklet` link in the app can be dragged to the bookmarks bar. Use it while viewing an Apple Music song page to copy the Spotify URL without opening the app first.

## How it works

The app calls Songlink/Odesli's public links endpoint:

```text
https://api.song.link/v1-alpha.1/links?url=<APPLE_MUSIC_URL>&userCountry=US
```

It then reads `linksByPlatform.spotify.url` from the JSON response. When that field is missing, it uses the song metadata in `entitiesByUniqueId` to build a Spotify search URL.

In production, the browser calls the same-origin Vercel function at `/api/links`, which proxies Songlink and avoids third-party CORS restrictions. Localhost uses Songlink directly.

If Songlink does not return a Spotify URL, the Vercel function can optionally query Spotify's Search API and attach a high-confidence track match before the browser falls back to a search URL. Configure these production environment variables to enable it:

```sh
vercel env add SPOTIFY_CLIENT_ID production
vercel env add SPOTIFY_CLIENT_SECRET production
vercel --prod
```

## Notes

- Country defaults to United States; change the dropdown if music availability should be resolved elsewhere.
- Songlink may not find every direct Spotify URL, especially when regional catalogs differ.
- The public API has rate limits, so repeated rapid conversions can temporarily fail.
