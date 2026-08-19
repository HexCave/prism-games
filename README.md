# prism-games

The content endpoint for the [Prism game launcher](https://github.com/HexCave/prims-game-launcher).

Everything here is **generated**. Games are written in the private
[prism-games-src](https://github.com/HexCave/prism-games-src) repository and
published into this one as bundles — minified code, copied assets, a file
manifest. Nothing in this repository should be edited by hand; the next publish
would overwrite it.

Served over GitHub Pages at **https://hexcave.github.io/prism-games/**.

## Layout

```
index.json                       the catalog the launcher reads
play.html, host.js               the page games run inside
sw.js                            serves downloaded games with no network
games/<id>/meta.json             player-facing metadata and release notes
games/<id>/cover.svg             card art, 16:9
games/<id>/<version>/            one immutable published build
    index.html main.js style.css prism-sdk.js
    manifest.json                every file, its size and SHA-256
```

A version directory never changes once published. That is what lets the service
worker cache a version once and replay it offline forever, and why a fix ships
as a new version rather than an edit.

## index.json

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "…",
  "host": "play.html",
  "categories": [{ "id": "arcade", "label": "Arcade", "count": 1 }],
  "games": [{
    "id": "neon-snake",
    "title": "Neon Snake",
    "tagline": "…", "description": "…",
    "category": "arcade", "tags": ["…"], "dimension": "2d",
    "author": "HexCave", "controls": ["…"],
    "cover": "games/neon-snake/cover.svg",
    "latest": "1.1.0",
    "versions": [{
      "version": "1.1.0",
      "path": "games/neon-snake/1.1.0",
      "entry": "index.html",
      "totalBytes": 15234, "files": 4,
      "releasedAt": "…", "notes": "…"
    }]
  }]
}
```

The catalog carries metadata only — a few kilobytes, no game code. The launcher
lists everything from it and downloads a version's files only when asked.

## Requirements of the host

Pages must serve this repository from the branch root. The service worker is at
the root so its scope covers `games/`, and `.nojekyll` keeps Pages from
rewriting the tree.

Any static host works as a replacement, as long as it serves correct content
types and does not send a restrictive `Content-Security-Policy`; point the
extension at it with `PRISM_CDN=https://… npm run build`.
