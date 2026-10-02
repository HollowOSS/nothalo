# Development setup


Use Node.js 22.18+ (tested with Node 25).

```sh
npm ci
npm run dev
```

An unconfigured installation shows setup instructions. The original game renderer requires a compatible external asset pack; this repository alone does not reproduce the complete game. No game images, audio, fonts, models, compiled bundles, or packed collision/navigation data are included.

Copy `public/runtime-config.example.json` to `public/runtime-config.json` (ignored by Git), then supply your pack locations:

```json
{
  "assetsBase": "ipfs://YOUR_MEDIA_DIRECTORY_CID",
  "dataBase": "ipfs://YOUR_LEVEL_DATA_DIRECTORY_CID",
  "ipfsGateway": "http://127.0.0.1:8080/ipfs/",
  "assetOverrides": {}
}
```

The example CID names are placeholders, not published packs. HTTP(S) directory URLs also work. `assetsBase` corresponds to the original `/assets/` directory, so it contains `maps/`, `characters/`, `viewmodels/`, `ce-models/`, `audio/`, and other referenced paths. Configure CORS on an external gateway. HTTPS deployments need an HTTPS gateway to avoid mixed-content blocking.

Individual files can be replaced without changing code:

```json
{
  "assetOverrides": {
    "/assets/characters/spartan.glb": "ipfs://YOUR_REPLACEMENT_CID/player.glb"
  }
}
```

Replacement models must preserve the node/animation contract expected by their loader. A file with the same extension alone is insufficient. See [the external data manifest](docs/external-data-manifest.json) for the 22 generated modules externalized from source. Each JSON file is named after the original module, with an object containing its named exports or a `default` key for its default export. Metadata and collision/navigation packs must agree with the rendered geometry.

For a configured pack, `/blood-gulch?offline&assets=full` starts offline bot mode. Online play requires a separately supplied compatible server; its private implementation cannot be recovered from browser source maps. The original `/ws`, matchmaking, and room endpoints are not implemented here.

## Build and checks

```sh
npm test
npm run build
npm run audit:source
npm run test:browser
npm run preview
```

Install a browser for the optional browser checks with `npx playwright install chromium` (or set `PLAYWRIGHT_CHANNEL=msedge` to use installed Edge).

Deploy `dist/` with SPA fallback routing. Runtime configuration is copied into a build if present in `public/`; review it before deploying. The source audit checks the working tree and reachable Git history for binary files and large encoded payloads. It is a technical content check, not a guarantee about every source file's IP status.
