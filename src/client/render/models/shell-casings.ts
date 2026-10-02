import * as THREE from 'three'

/**
 * Spent brass leaving a ballistic gun's ejection port in first person: flung out to the right and up, tumbling, falling
 * away under gravity out of the bottom of the frame. One instanced draw per weapon, a fixed pool, nothing allocated per
 * shot. Lives in the HeldWeapon's own (camera) space, so it rides with the view like the flash does; gravity is turned
 * into that space every frame so a casing still falls "down" while the player looks up or down.
 */
interface Kind { radius: number; length: number; color: number; rim?: number; delay: number; speed: number }
/** Real cartridge sizes (m) and when the case leaves: at the shot for self-loaders, on the pump / bolt stroke otherwise. */
const KINDS: Partial<Record<string, Kind>> = {
  magnum: {radius: .0065, length: .033, color: 0xa88650, delay: 0, speed: 2.4},
  smg: {radius: .0048, length: .019, color: 0xa88650, delay: 0, speed: 2.2},
  'assault-rifle': {radius: .0055, length: .045, color: 0xa88650, delay: 0, speed: 2.6},
  'battle-rifle': {radius: .006, length: .051, color: 0xa88650, delay: 0, speed: 2.6},
  sniper: {radius: .0095, length: .1, color: 0xa88650, delay: 0, speed: 1.8},
  shotgun: {radius: .0105, length: .065, color: 0xa4231c, rim: 0xc9a14a, delay: .3, speed: 1.6},
}

export interface ShellCasings { object: THREE.Object3D; eject(port: THREE.Vector3, scale: number, mirror: boolean): void; update(dt: number, down: THREE.Vector3): void }

export function createShellCasings(id: string): ShellCasings | null {
  const kind = KINDS[id]
  if (!kind) return null
  const count = 10
  // a case: a short cylinder, with the brass head as a slightly wider ring for the shotgun's plastic hull
  const body = new THREE.CylinderGeometry(1, 1, 1, 10, 1).rotateX(Math.PI / 2)
  const material = new THREE.MeshStandardMaterial({color: kind.color, metalness: kind.rim ? .1 : .9, roughness: kind.rim ? .5 : .36, name: `${id}-casing`})
  // viewmodel-look.ts gives it the map's reflection; the flag keeps its own values instead of a derived surface
  material.userData.viewmodelLook = {env: 1.3}
  const mesh = new THREE.InstancedMesh(body, material, count)
  mesh.name = 'shell-casings'; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const zero = new THREE.Matrix4().makeScale(0, 0, 0)
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zero)
  mesh.visible = false
  const items = Array.from({length: count}, () => ({live: false, wait: 0, age: 0, at: new THREE.Vector3(), v: new THREE.Vector3(),
    spin: new THREE.Vector3(), q: new THREE.Quaternion(), scale: 1}))
  let next = 0
  const m = new THREE.Matrix4(), dq = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3()
  return {
    object: mesh,
    eject(port, scale, mirror) {
      const it = items[next]; next = (next + 1) % count
      const side = mirror ? -1 : 1
      it.live = true; it.wait = kind.delay; it.age = 0; it.scale = scale
      it.at.copy(port)
      // out to the right, up, and a little back toward the shooter, with some scatter
      it.v.set(side * (1 + Math.random() * .3), .85 + Math.random() * .35, .25 + Math.random() * .2).normalize()
        .multiplyScalar(kind.speed * scale * (.85 + Math.random() * .3))
      it.spin.set((Math.random() - .5) * 30, (Math.random() - .5) * 10, side * (18 + Math.random() * 14))
      it.q.setFromEuler(e.set(0, side * Math.PI / 2, 0))
      mesh.visible = true
    },
    update(dt, down) {
      let live = false
      items.forEach((it, i) => {
        if (!it.live) return
        if (it.wait > 0) { it.wait -= dt; mesh.setMatrixAt(i, zero); live = true; return }
        it.age += dt
        if (it.age > .6) { it.live = false; mesh.setMatrixAt(i, zero); return }
        live = true
        it.v.addScaledVector(down, 9.8 * it.scale * dt)
        it.at.addScaledVector(it.v, dt)
        it.q.multiply(dq.setFromEuler(e.set(it.spin.x * dt, it.spin.y * dt, it.spin.z * dt)))
        s.set(kind.radius, kind.radius, kind.length).multiplyScalar(it.scale)
        mesh.setMatrixAt(i, m.compose(it.at, it.q, s))
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.visible = live
    },
  }
}
