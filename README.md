# Not Halo

Halo-style multiplayer in your browser, by [Caden Burleson](https://github.com/CadenBurleson).

**[Play at nothalo.lol](https://nothalo.lol)** · **[Watch gameplay](https://x.com/CadenBurleson/status/2105346544459460954)**

[![Blood Gulch on Not Halo](https://nothalo.lol/assets/menu/blood-gulch.jpg)](https://nothalo.lol/blood-gulch)

Jump into Team Slayer or free-for-all, practice against bots, and explore Blood Gulch, Guardian, Lockout, and more. The live game supports desktop, phone, and tablet.

| Guardian | Lockout |
| --- | --- |
| [![Guardian](https://nothalo.lol/assets/menu/guardian.jpg)](https://nothalo.lol/guardian) | [![Lockout](https://nothalo.lol/assets/menu/lockout.jpg)](https://nothalo.lol/lockout) |

Images are linked directly from [nothalo.lol](https://nothalo.lol).

## Gameplay

[![Watch Caden’s gameplay video](https://pbs.twimg.com/amplify_video_thumb/2105346036160253952/img/EPmP0vYGBFCMUQdt.jpg)](https://x.com/CadenBurleson/status/2105346544459460954)

[Watch on X](https://x.com/CadenBurleson/status/2105346544459460954) · [Open video](https://video.twimg.com/amplify_video/2105346036160253952/vid/avc1/1280x720/jyCzkivqRth-G9Xf.mp4?tag=14)

## Controls

WASD to move, mouse to aim, click to fire, Space to jump, Shift to crouch, R to reload, Q to switch weapons, G to throw a grenade, and E to enter or exit a vehicle.

## Development

```sh
npm ci
npm run dev
```

Media and map data load from configurable HTTP or IPFS URLs. Set their locations in `public/runtime-config.json` before playing locally. See [setup instructions](docs/setup.md) for configuration, builds, and tests. This repository contains the client; online matchmaking requires a compatible server.

Maintained here by [HollowOSS](https://github.com/HollowOSS).
