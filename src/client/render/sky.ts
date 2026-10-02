import * as THREE from 'three'
import { DEBUG_HOOKS } from '../debug/build-flags.ts'

/**
 * Owner: sky/lighting piece. Sky, fog, sun, and the overall colour grade.
 *
 * The whole sky is one analytic fragment shader on a camera-locked box: gradient,
 * twinkling stars, the Halo ring and its walls, Threshold, a cumulus deck and the horizon cirrus. One draw call, no textures
 * to fetch, and the ring is a real ray/cylinder intersection so its perspective
 * (pencil-thin overhead, flaring out where it meets the horizon) falls out for free
 * instead of being faked with a painted strip.
 *
 * Colours are authored and written in sRGB, not linear. The reference frames are
 * sRGB screenshots of a 2001 renderer with no tone mapping, so hitting their byte
 * values directly is both the shortest path to the look and what the era's art did.
 */

/** Direction helper: compass azimuth (0 = +Z, 90 = +X) and elevation, both degrees. */
function dir(azDeg: number, elevDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azDeg)
  const el = THREE.MathUtils.degToRad(elevDeg)
  const h = Math.cos(el)
  return new THREE.Vector3(Math.sin(az) * h, Math.sin(el), Math.cos(az) * h)
}

/**
 * Where the ring meets the horizon.
 *
 * KNOWN CONFLICT. `base-exterior-blue` puts the band's foot at x~1400 and
 * `ridge-overlook` puts it at x~450, but those two vantage cameras happen to map world
 * azimuth to screen x almost identically, so no single azimuth satisfies both — one of
 * the two vantages in `debug/vantage.ts` is yawed wrong against its reference frame.
 * This value is fitted to `base-exterior-blue` — the band's centre lands at 72% of frame
 * width, matching the reference — and keeps the ring off screen in `base-exterior-red`,
 * which correctly shows none. In `ridge-overlook` only the pale flared foot shows, right
 * of centre instead of left.
 *
 * Note azimuth increases to the *left* on screen: three.js builds the camera's +X from
 * cross(up, eye - target), so screen-right is (camera azimuth - 90).
 */
const RING_TANGENT_AZ = 22
/**
 * Band width, and how fast it flares as it nears the horizon. A true ray/cylinder
 * solve flares as 1/sin(elev); measured off the frames the reference band only widens
 * from ~3.6 deg at 27 deg up to ~10 deg at 4 deg up. Halo's skybox ring is not drawn at
 * true scale, so the exponent buys the reference's shape and stops the foot of the band
 * from smearing out along the whole horizon.
 */
const RING_HALF_WIDTH = 0.051
const RING_FLARE = 0.40

/**
 * Threshold. Fitted, not eyeballed: the bright limb was traced out of
 * `base-exterior-red` row by row, unprojected through that vantage's camera, and a
 * direction + angular radius solved for. 19 limb samples, 0.3 deg RMS.
 */
const THRESHOLD_AZ = 181
const THRESHOLD_ELEV = 32
const THRESHOLD_RADIUS_DEG = 32.4

/**
 * The light that shades Threshold is NOT the light that lights the canyon. In the
 * reference the gas giant carries a thin crescent along its lower-right limb — a phase
 * angle of ~150 deg, i.e. a sun almost directly behind it — while the canyon is lit
 * from the opposite side by a high sun. Bungie's skybox and scene lighting disagree;
 * copying the frames means copying that disagreement.
 */
const THRESHOLD_SUN = dir(146.5, 5.5)
/** Rotation axis, so the cloud bands run parallel to the crescent as they do in frame. */
const THRESHOLD_AXIS = new THREE.Vector3(0.5554, 0.7094, 0.4337)

/**
 * Canyon sun. Behind the camera and to its right, which is what puts the near -X cliff's
 * shadow *edge* into the frame as the long diagonal band the reference throws across the
 * foreground grass.
 *
 * Elevation is forced much higher than the reference's low warm sun, and that is not a
 * taste call. CLIFF_HEIGHT is 70 m across a 170 m canyon (shared/map.ts), so a 20 deg sun
 * throws a 190 m shadow — wider than the floor — and every vantage renders as one flat
 * unlit sheet, which is exactly how the previous pass failed. At 49 deg the -X wall
 * shadows about 35 m in X, which is short enough to leave both base vantages' floors
 * mostly lit and long enough that its edge still crosses the frame diagonally. If the
 * terrain piece ever brings the walls down to the ~25 m the reference frames imply, drop
 * this back to 18-20 and the light will be the reference's rather than a compromise.
 */
const SUN_AZ = 215
const SUN_ELEV = 49

/**
 * Sky gradient: blue hour rather than CE's flat midday. A pale, luminous band at the horizon
 * falls away within a few degrees to deep blue and on to near-black navy overhead, so the stars
 * carry, and the ring and Threshold stand out lit against it instead of washing into the blue.
 * (elevation degrees, sRGB 0..1)
 */
const SKY_RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0.80, 0.86, 0.96],
  [1.5, 0.64, 0.75, 0.93],
  [3, 0.46, 0.60, 0.87],
  [5, 0.31, 0.45, 0.78],
  [8, 0.20, 0.32, 0.66],
  [12, 0.13, 0.22, 0.54],
  [17, 0.085, 0.155, 0.43],
  [25, 0.055, 0.105, 0.33],
  [35, 0.036, 0.072, 0.25],
  [50, 0.024, 0.050, 0.185],
  [70, 0.017, 0.036, 0.145],
  [90, 0.014, 0.030, 0.13],
]

/** 1-D LUT indexed by sqrt(elevation/90) so the fast horizon wash gets most of the texels. */
function skyRampTexture(): THREE.DataTexture {
  const n = 512
  const data = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const v = i / (n - 1)
    const elev = 90 * v * v
    let k = 0
    while (k < SKY_RAMP.length - 2 && SKY_RAMP[k + 1]![0] < elev) k++
    const a = SKY_RAMP[k]!
    const b = SKY_RAMP[k + 1]!
    const f = THREE.MathUtils.clamp((elev - a[0]) / (b[0] - a[0]), 0, 1)
    data[i * 4 + 0] = Math.round(255 * (a[1] + f * (b[1] - a[1])))
    data[i * 4 + 1] = Math.round(255 * (a[2] + f * (b[2] - a[2])))
    data[i * 4 + 2] = Math.round(255 * (a[3] + f * (b[3] - a[3])))
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat)
  // The ramp already holds sRGB bytes; nothing may re-encode it.
  tex.colorSpace = THREE.NoColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pin to the far plane so opaque geometry always wins
}
`

const FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform sampler2D uRamp;
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uRingAxis;
uniform vec3 uRingTangent;
uniform float uRingHalf;
uniform float uRingFlare;
uniform vec3 uGiant;
uniform float uGiantSin;
uniform vec3 uGiantSun;
uniform vec3 uGiantAxis;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * noise2(p); p *= 2.07; a *= 0.5; }
  return s / 0.875;
}

float fbm2x(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * noise2(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.984375;
}

float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * noise3(p); p *= 2.03; a *= 0.5; }
  return s / 0.875;
}

// One grid of stars. Each twinkles on its own clock: two incommensurate sines so no two stars
// pulse together and none settles into an obvious beat, deeper (scintillation) the more air the
// light crosses, with the faint colour flicker real low stars have.
vec3 starField(vec3 d, float scale, float density, float gain, float elev) {
  vec3 sp = d * scale;
  vec3 sc = floor(sp);
  if (hash13(sc) <= density) return vec3(0.0);
  vec3 jit = vec3(hash13(sc + 2.7), hash13(sc + 5.1), hash13(sc + 9.3));
  float r = length(fract(sp) - jit);
  float mag = pow(hash13(sc + 13.7), 2.0);
  float rate = 1.4 + 4.2 * hash13(sc + 21.1);
  float ph = 6.2832 * hash13(sc + 17.3);
  float flick = 0.5 + 0.32 * sin(uTime * rate + ph) + 0.18 * sin(uTime * rate * 2.37 + ph * 3.1);
  float air = 1.0 - smoothstep(12.0, 70.0, elev);
  float tw = mix(1.0, 0.12 + 1.7 * flick * flick, mix(0.6, 0.95, air));
  vec3 tint = mix(vec3(0.82, 0.87, 1.0), vec3(1.0, 0.9, 0.82), (0.5 + 0.5 * sin(uTime * rate * 1.63 + ph * 5.0)) * air);
  return tint * smoothstep(0.32, 0.04, r) * (0.22 + 0.95 * mag) * tw * gain;
}

// Cumulus deck density at a point on its plane; coverage leaves most of the sky open. 'thin'
// raises the threshold: overhead, where the deck is nearest, cover breaks up into separate
// clouds with crisp edges instead of one soft blanket.
float cumulus(vec2 p, float thin) {
  float n = fbm2x(p);
  float lo = 0.55 + 0.07 * thin;
  return smoothstep(lo, lo + mix(0.24, 0.12, thin), n);
}

void main() {
  vec3 d = normalize(vDir);
  float elev = degrees(asin(clamp(d.y, -1.0, 1.0)));

  vec3 col = texture2D(uRamp, vec2(sqrt(clamp(elev, 0.0, 90.0) / 90.0), 0.5)).rgb;
  // Below the horizon (seen from the rims) the glow gives way to dusky haze, leaving the
  // horizon itself a bright line.
  col = mix(col, vec3(0.22, 0.27, 0.42), smoothstep(0.0, -6.0, elev));

  // The sky is lit from somewhere: a broad warm lift on the sun's side and a tighter aureole round
  // it. No disc — the glare (arena-light-fx.ts) is the sun itself.
  float sd = max(dot(d, uSun), 0.0);
  col += vec3(0.42, 0.30, 0.18) * (pow(sd, 5.0) * 0.30 + pow(sd, 40.0) * 0.55) * smoothstep(-2.0, 6.0, elev);
  // The low sun warms the horizon on its side of the sky: a band of amber under the blue.
  float sunSide = pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-5)), 0.0), 2.0);
  col += vec3(0.55, 0.30, 0.12) * sunSide * exp(-max(elev, 0.0) / 5.0) * 0.55;

  // Stars. Thin atmosphere, so they read well into the daylit blue; the last few
  // degrees of air near the horizon still swallow them.
  // A 3-D cell grid rather than a projected 2-D one: any sphere parameterisation lays
  // a visible seam of stretched cells across the sky.
  // A star that lands inside a single pixel averages away to nothing, which is how the
  // last pass ended up with half a dozen visible ones against the reference's hundreds.
  // Cells are ~0.22 deg and the disc is deliberately wider than a pixel at 1080p. A second,
  // finer and fainter grid fills the dark between them.
  float starFade = smoothstep(2.0, 16.0, elev);
  if (starFade > 0.0) {
    col += (starField(d, 260.0, 0.958, 1.25, elev) + starField(d, 470.0, 0.972, 0.6, elev)) * starFade;
  }

  // The ring. Observer stands on the inner surface of a cylinder of radius R whose
  // centre is straight up, so the ray/cylinder solve collapses to t = 2R*d.y/(1-n^2)
  // and R divides out of everything the shading needs.
  float n = dot(d, uRingAxis);
  float den = max(1.0 - n * n, 1e-4);
  float axial = 2.0 * pow(max(d.y, 1e-4), uRingFlare) * n / den;   // axial offset, over R
  float aa = fwidth(axial) * 0.9 + 1e-5;
  // The ring has walls: tall rims along both edges, seen face-on from inside because we stand
  // between them. They show as a strip just outside each edge of the band, widest low down where
  // the ring is nearest, and are what makes the band read as a structure rather than a painted
  // stripe. The one facing the sun is lit, the other in its own shade.
  float wallW = uRingHalf * mix(0.30, 0.11, smoothstep(4.0, 40.0, elev));
  float edge = abs(axial) - uRingHalf;
  float foot = smoothstep(0.4, 3.2, elev);
  // The last couple of degrees of the band drown in the horizon wash rather than
  // running out sideways along it.
  float band = (1.0 - smoothstep(-aa, aa, edge)) * foot;
  float wall = smoothstep(-aa, aa, edge) * (1.0 - smoothstep(wallW - aa, wallW + aa, edge)) * foot;
  if (band + wall > 0.002) {
    float alongUp = 2.0 * d.y * d.y / den - 1.0;
    float alongTan = 2.0 * d.y * dot(d, uRingTangent) / den;
    vec2 rc = vec2(atan(alongTan, alongUp) * 2.0, axial / uRingHalf);
    // Sunlit along its whole length against the dark sky, brightest and palest where it meets
    // the horizon (it is nearest there, and we see its lit face most squarely), cooler and a
    // little dimmer arching overhead. The foot runs just past the bloom threshold, so it glows.
    float k0 = 0.70 * (1.0 - smoothstep(7.0, 22.0, elev));
    float k = (0.45 + k0 * 0.8) * (0.82 + 0.36 * fbm2(rc * vec2(1.1, 1.3) + 4.0));
    vec3 ring = mix(vec3(0.34, 0.44, 0.70), vec3(1.04, 1.03, 1.06), clamp(k, 0.0, 1.0));
    // Continents, seas and weather on the inner surface, in the ring's own coordinates so they
    // foreshorten with it: broad land, then cloud streets drifting slowly across it.
    float land = fbm2(rc * vec2(5.0, 3.5) - 2.0);
    ring *= mix(vec3(1.03, 1.02, 1.0), vec3(0.70, 0.78, 0.92), smoothstep(0.30, 0.72, land));
    float weather = fbm2(rc * vec2(16.0, 7.0) + vec2(uTime * 0.004, 1.3));
    ring = mix(ring, vec3(0.97, 0.97, 1.0), smoothstep(0.58, 0.82, weather) * mix(0.25, 0.55, k0));
    // Terrain relief catches the light across the band: the side nearer the sun a shade brighter.
    ring *= 1.0 + 0.06 * clamp(rc.y, -1.0, 1.0) * sign(dot(uRingAxis, uSun));

    // Wall faces: the one at +axis faces -axis, so it is lit when the sun sits on the -axis side.
    float lit = clamp(-sign(axial) * dot(uRingAxis, uSun) * 1.6 + 0.35, 0.0, 1.0);
    float across = clamp(edge / wallW, 0.0, 1.0);
    vec3 face = mix(vec3(0.16, 0.19, 0.32), vec3(0.80, 0.80, 0.86), lit);
    // Structural ribs along the wall and a darker lip at its top edge.
    face *= 0.92 + 0.08 * sin(rc.x * 180.0);
    face *= mix(1.0, 0.72, smoothstep(0.55, 1.0, across));
    // The same air that washes the band's foot washes the walls.
    face = mix(face, vec3(0.80, 0.84, 0.93), k0 * 0.45);
    col = mix(col, ring, band);
    col = mix(col, face, wall);
  }
  // Light scattered round the band: a faint halo that makes it read as lit, not painted.
  col += vec3(0.10, 0.13, 0.22) * exp(-max(abs(axial) - uRingHalf, 0.0) / (uRingHalf * 0.9)) * foot
       * (1.0 - band - wall) * (0.6 + 0.4 * (1.0 - smoothstep(5.0, 40.0, elev)));

  // Threshold. The disc coordinate and its screen derivative are computed outside the
  // branch on purpose: fwidth() inside a divergent branch is undefined, and it showed
  // up as a hairline arc along the branch boundary right across the sky.
  float cg = dot(d, uGiant);
  float rr = sqrt(max(1.0 - cg * cg, 0.0)) / uGiantSin;
  float drr = fwidth(rr);
  if (cg > 0.0 && rr < 1.2) {
    vec3 perp = d - cg * uGiant;
    float plen = length(perp);
    perp = plen > 1e-6 ? perp / plen : vec3(0.0);
    float disc = 1.0 - smoothstep(1.0 - drr, 1.0 + drr, rr);
    float s = min(rr, 1.0);
    float mu = sqrt(max(1.0 - s * s, 0.0));   // cosine between the surface and our line of sight
    vec3 nrm = perp * s - uGiant * mu;

    // Turn the sphere slowly about its axis so the weather in the bands drifts, then bend the
    // bands with it: straight latitude stripes are what made the planet look like a flat decal.
    float spin = uTime * 0.0025;
    vec3 ax = uGiantAxis;
    vec3 q = nrm * cos(spin) + cross(ax, nrm) * sin(spin) + ax * dot(ax, nrm) * (1.0 - cos(spin));
    float lat = dot(nrm, ax);
    lat += (fbm3(q * 3.2) - 0.5) * 0.10 + (fbm3(q * 9.0 + 4.0) - 0.5) * 0.035;
    float bands = mix(sin(lat * 9.0) * 0.5 + 0.5, fbm2(vec2(lat * 5.0, 3.0)), 0.65);
    bands = mix(bands, fbm2(vec2(lat * 22.0, 7.0)), 0.3);
    // Band endpoints solved back through the haze mix from the frame's own pixels.
    vec3 body = mix(vec3(0.07, 0.07, 0.38), vec3(0.17, 0.19, 0.52), bands);
    // Limb darkening: the edge of a gas giant is seen through more of its own haze.
    body *= 0.70 + 0.30 * pow(mu, 0.5);
    // The terminator sits ~30% of the radius in from the limb; sunward of it the
    // crescent runs pale lavender, not white.
    float cres = pow(clamp(dot(nrm, uGiantSun) / 0.50, 0.0, 1.0), 0.75);
    body = mix(body, vec3(1.08, 1.02, 1.08), cres);
    // Its atmosphere scattering along the whole limb, strongest on the sunward side.
    float rim = pow(1.0 - mu, 4.0);
    body += rim * mix(vec3(0.16, 0.12, 0.38), vec3(0.45, 0.40, 0.58), cres);
    body = mix(body, col, mix(0.30, 0.02, cres));   // that much air between us and it

    // The crescent bleeds a little past the limb as atmospheric glow.
    float glow = exp(-max(rr - 1.0, 0.0) * 60.0)
               * clamp(dot(normalize(perp), normalize(uGiantSun - dot(uGiantSun, uGiant) * uGiant)), 0.0, 1.0);
    col = mix(col, body, disc) + glow * (1.0 - disc) * vec3(0.26, 0.22, 0.34);
  }

  // Cumulus. A real deck ~900 m up rather than a pattern painted on the dome: each view ray is
  // run out to the deck's plane from where the camera actually stands, so clouds keep their
  // place as you cross the map, crowd into flat streets towards the horizon and drift with the
  // wind. Each is lit by comparing its density with a step towards the sun — thinning sunward
  // means a lit edge, thickening a shaded underside — which is what gives them volume.
  if (d.y > 0.02) {
    float h = (900.0 - cameraPosition.y) / d.y;
    vec2 cp = (cameraPosition.xz + d.xz * h) / 520.0 + vec2(uTime * 0.0045, uTime * 0.0018);
    float thin = smoothstep(0.25, 0.9, d.y);
    float c = cumulus(cp, thin);
    float fade = smoothstep(0.02, 0.16, d.y);
    if (c * fade > 0.003) {
      vec2 sunStep = normalize(uSun.xz + 1e-4) * 0.09;
      float towards = cumulus(cp + sunStep, thin);
      float light = clamp(0.55 + (c - towards) * 2.4, 0.0, 1.0);
      // Low sun: lit edges go gold towards it, shade is the dusky blue of the sky behind.
      vec3 lit = mix(vec3(0.95, 0.86, 0.80), vec3(1.10, 0.72, 0.42), sunSide * 0.8 + pow(sd, 3.0) * 0.4);
      vec3 shade = mix(vec3(0.20, 0.24, 0.40), col, 0.3);
      vec3 cloud = mix(shade, lit, light);
      // Far clouds sit in the same haze as the horizon.
      cloud = mix(cloud, col, (1.0 - smoothstep(0.02, 0.25, d.y)) * 0.45);
      col = mix(col, cloud, c * fade * 0.92);
    }
  }

  // Cirrus. One thin deck, not a band: optical depth through a flat layer goes as
  // 1/sin(elev), so it piles up into solid streaks where it meets the horizon and thins
  // to a faint veil overhead. An elevation *band* instead draws its own inner edge as a
  // hard arc round the zenith, which is very obviously not what the reference has.
  // Noise is squashed hard in y so the streaks lie flat; they drift, slower than the cumulus
  // below them.
  float env = clamp(0.155 / max(d.y, 0.04), 0.0, 1.0) * smoothstep(0.2, 2.2, elev);
  if (env > 0.004) {
    vec3 cd = vec3(d.x * 1.1 + uTime * 0.0012, d.y * 19.0, d.z * 4.2 + uTime * 0.0006);
    float f = fbm3(cd);
    f = mix(f, fbm3(vec3(cd.x * 2.7, d.y * 52.0, cd.z * 2.6)), 0.3);
    vec3 cloud = mix(vec3(0.42, 0.50, 0.72), vec3(0.90, 0.84, 0.82), smoothstep(0.44, 0.86, f));
    cloud = mix(cloud, vec3(1.0, 0.70, 0.45), sunSide * 0.5);
    col = mix(col, cloud, smoothstep(0.455, 0.86, f) * env * 1.1);
  }

  // 8-bit output over a very smooth gradient bands badly without this.
  col += (hash21(gl_FragCoord.xy) - 0.5) * (1.6 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}
`

/** @param sun towards the canyon's sun, for the sky's glow, the ring's walls and the clouds' lit sides. */
export function createSkyDome(sun: THREE.Vector3 = dir(SUN_AZ, SUN_ELEV)): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uRamp: { value: skyRampTexture() },
      uTime: { value: 0 },
      uSun: { value: sun.clone().normalize() },
      uRingAxis: { value: dir(RING_TANGENT_AZ + 90, 0) },
      uRingTangent: { value: dir(RING_TANGENT_AZ, 0) },
      uRingHalf: { value: RING_HALF_WIDTH },
      uRingFlare: { value: RING_FLARE },
      uGiant: { value: dir(THRESHOLD_AZ, THRESHOLD_ELEV) },
      uGiantSin: { value: Math.sin(THREE.MathUtils.degToRad(THRESHOLD_RADIUS_DEG)) },
      uGiantSun: { value: THRESHOLD_SUN },
      uGiantAxis: { value: THRESHOLD_AXIS.clone().normalize() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  })

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material)
  mesh.name = 'sky'
  mesh.frustumCulled = false
  // Drawn after opaque geometry so early-z throws away the covered pixels.
  mesh.renderOrder = 1000
  mesh.userData.skyOwned = true
  // Its own clock, so the stars twinkle and the clouds drift wherever the dome is used.
  const time = material.uniforms.uTime!
  mesh.onBeforeRender = (_r, _s, camera) => {
    mesh.position.copy(camera.position)
    mesh.updateMatrixWorld()
    time.value = performance.now() / 1000
  }
  return mesh
}

/**
 * Shadow casting/receiving has to be switched on per-mesh, but terrain, bases and
 * vehicles are owned by other pieces and are added after this runs (and some stream in
 * later still). Rather than reach into their files, sweep the scene periodically and
 * turn shadows on for anything that has not opted out via `userData.noShadow`.
 */
function makeShadowSweeper(scene: THREE.Scene): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
  geometry.setDrawRange(0, 0)
  const probe = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }))
  probe.name = 'sky:shadow-sweeper'
  probe.frustumCulled = false
  probe.renderOrder = -1000
  probe.userData.skyOwned = true

  let frame = 0
  probe.onBeforeRender = () => {
    if (frame++ % 30 !== 0) return
    scene.traverse((o) => {
      if (o.userData.skyOwned || o.userData.noShadow || o.userData.skyShadowDone) return
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      o.userData.skyShadowDone = true
      mesh.castShadow = true
      mesh.receiveShadow = true
    })
  }
  return probe
}

/**
 * Which shadow technique to use. PCF everywhere; `?shadows=` overrides for comparison with
 * `vsm`, `basic` or `off`, which is how the iOS disappearing-map bug was bisected (it turned
 * out to be the runtime shadow toggle in quality.ts, not the technique).
 */
function pickShadowMap(renderer: THREE.WebGLRenderer): void {
  const mode = new URLSearchParams(location.search).get('shadows') ?? 'pcf'
  renderer.shadowMap.enabled = mode !== 'off'
  renderer.shadowMap.type = mode === 'vsm' ? THREE.VSMShadowMap : mode === 'basic' ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap
}

export function createSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  pickShadowMap(renderer)
  // Flat, untone-mapped output: the reference is a 2001 forward renderer.
  renderer.toneMapping = THREE.NoToneMapping

  scene.background = null
  // Barely any fog — the frames desaturate distance rather than veil it — but the far
  // mesas do sit a shade lighter and bluer than the near walls.
  scene.fog = new THREE.Fog(0x9fb4dd, 90, 1050)

  scene.add(createSkyDome())
  scene.add(makeShadowSweeper(scene))

  const sun = new THREE.DirectionalLight(0xffeec4, 2.9)
  sun.position.copy(dir(SUN_AZ, SUN_ELEV)).multiplyScalar(320)
  sun.target.position.set(0, 8, 0)
  sun.castShadow = true
  sun.shadow.mapSize.set(2560, 2560)
  // One ortho box over the whole canyon (300 x 170 m plus the cliffs). At ~9.5 texels/m
  // the PCF penumbra reads as the soft-edged shadow the reference throws, not as aliasing.
  const sc = sun.shadow.camera
  sc.left = -135
  sc.right = 135
  sc.top = 135
  sc.bottom = -135
  sc.near = 20
  sc.far = 700
  sc.updateProjectionMatrix()
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 0.7
  sun.shadow.autoUpdate = false
  sun.shadow.needsUpdate = true
  sun.userData.skyOwned = true
  sun.target.userData.skyOwned = true
  scene.add(sun)
  scene.add(sun.target)
  let shadowTime = 0
  scene.userData.tickShadows = (dt: number) => {
    shadowTime += dt
    if (shadowTime >= 1) { shadowTime = 0; sun.shadow.needsUpdate = true }
  }

  // Bright, clearly blue ambient — shadowed rock in the frames stays legible and cool.
  const ambient = new THREE.HemisphereLight(0x93b4ef, 0x6b5540, 1.15)
  ambient.userData.skyOwned = true
  scene.add(ambient)

  installSkyDebug(scene, renderer, sun)
}

/** Dev hook: the shadow wiring reaches into meshes this piece does not own, so expose
 * enough state to tell "shadows are off" apart from "shadows are on and pointed wrong". */
function installSkyDebug(scene: THREE.Scene, renderer: THREE.WebGLRenderer, sun: THREE.DirectionalLight): void {
  if (!DEBUG_HOOKS) return
  ;(window as unknown as Record<string, unknown>).__sky = () => {
    let meshes = 0
    let casters = 0
    let receivers = 0
    const materials = new Set<string>()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || o.userData.skyOwned) return
      meshes++
      if (m.castShadow) casters++
      if (m.receiveShadow) receivers++
      const mat = m.material as THREE.Material
      materials.add(Array.isArray(m.material) ? 'array' : mat.type)
    })
    return {
      shadowMapEnabled: renderer.shadowMap.enabled,
      meshes,
      casters,
      receivers,
      materials: [...materials],
      sunDir: sun.position.clone().normalize().toArray().map((n) => Math.round(n * 100) / 100),
      sunIntensity: sun.intensity,
    }
  }
}
