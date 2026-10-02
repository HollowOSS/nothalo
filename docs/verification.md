# Verification — 2026-10-02

- Production build: Vite 8.3.2 / Three.js 0.185.0, Node 25.6.1, Windows.
- Configuration unit checks: IPFS directory resolution, individual replacement URLs, separate data directories, missing configuration, rejection of HTML in place of JSON.
- Browser checks: unconfigured startup without media requests; invalid external pack produces a recoverable error.
- Manual integration harness, automated in headless Microsoft Edge: loaded the reconstructed production client at `/blood-gulch?offline&assets=full`, reached the offline bot match, acquired pointer lock, sent movement input, fired the weapon (60 → 40 rounds), and reloaded (40 → 60). No uncaught page errors or failed asset requests occurred. Other maps and multiplayer have not been verified.

The integration harness supplied the original deployed media through transient browser request interception and generated JSON from recovered map-data modules outside the Git checkout. It fetched 304 media resources during the gameplay test. No media payloads, screenshots, data packs, or upstream asset proxy are distributed here. This verifies the code with compatible external assets; it does not mean a fresh checkout includes everything needed to play.

No actual IPFS CID was supplied or pinned. IPFS URL resolution was tested, but a Helia node or gateway was not deployed for this import. A compatible asset/data pack remains an external deployment requirement.
