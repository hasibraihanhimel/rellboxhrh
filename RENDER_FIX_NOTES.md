# Render playback fix

This copy preserves the original project and adds a safe fallback for upstream media servers that reject Render's `/api/media/...` proxy with HTTP 426.

## Changes

- `api.py`
  - Exposes the original signed source as `direct_url` in stream metadata.
  - Adds browser-like media headers to proxy requests.
  - Sends `Accept-Encoding: identity` to avoid compressed range responses.
  - Preserves the existing proxy and retry behavior.
- `static/app.js`
  - Tries the Render media proxy first.
  - If the proxy fails, tries the original direct media URL for that same quality.
  - Then continues to the next quality if both methods fail.
- `static/index.html`
  - Bumps the JavaScript cache version to `20261006-4` so browsers do not keep the old player.

## Redeploy

1. Replace the matching files in the GitHub repository with this copy, or upload this whole folder to a new repository.
2. Commit to the branch connected to Render.
3. Wait for Render to deploy the new commit.
4. Open the live site in a private/incognito window or hard-refresh with `Ctrl+Shift+R`.
5. Open a Watch page and click the play button.

## Limitation

The direct fallback works only if the upstream CDN permits direct browser playback. If it also rejects direct requests, an authorized upstream player/API or a different permitted media source is required; no Render setting can override an upstream HTTP 426 response.
