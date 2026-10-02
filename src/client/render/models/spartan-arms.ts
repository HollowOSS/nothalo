import { assetUrl } from '../../../shared/runtime-config.ts'
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { preloadSpartan, spartanMaterial, armorOf, injectShieldRim, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH } from './character.ts'
import type { Team } from '../../../shared/map.ts'
import { injectArmor } from './armor-surface.ts'
import { poseFingers } from './finger-pose.ts'
import { buildSpareMag } from './viewmodel.ts'
import type { Arms, HandAnchor, WeaponRig } from './viewmodel.ts'

/** Bake weapon-specific poses from the Blender finger rig; GPU morphs animate the trigger. */
export async function buildSpartanArms(rig: WeaponRig, team?: Team): Promise<Arms> {
  const source = cloneSkinned(await preloadSpartan())
  source.updateMatrixWorld(true)
  let skin: THREE.SkinnedMesh | undefined
  source.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skin = o as THREE.SkinnedMesh })
  if (!skin) throw new Error('Spartan GLB has no skinned mesh')
  const mesh = skin
  const group = new THREE.Group()
  group.name = 'spartan-viewmodel-arms'
  group.userData.source = assetUrl('/assets/characters/spartan.glb')
  const make = (side: 'Left' | 'Right', anchor: HandAnchor) => {
    const hand = mesh.skeleton.bones.find(b => b.name === `${side}Hand`)!
    const forearm = mesh.skeleton.bones.find(b => b.name === `${side}ForeArm`)!
    const wrist = hand.getWorldPosition(new THREE.Vector3())
    const elbow = forearm.getWorldPosition(new THREE.Vector3())
    const y = wrist.clone().sub(elbow).normalize()
    const x = new THREE.Vector3().crossVectors(y, new THREE.Vector3(0, 0, 1)).normalize()
    const z = new THREE.Vector3().crossVectors(x, y).normalize()
    const basis = new THREE.Matrix4().makeBasis(x, y, z).setPosition(wrist).invert()
    const geo = mesh.geometry.clone()
    const weights = geo.getAttribute('skinWeight'), joints = geo.getAttribute('skinIndex')
    const accepted = new Set(mesh.skeleton.bones.flatMap((b,i) => b === hand || b === forearm || new RegExp(`^${side}(Thumb|Index|Middle|Ring|Pinky)`).test(b.name) ? [i] : []))
    const keep = (v: number) => {
      let w = 0
      for (let j = 0; j < 4; j++) if (accepted.has(joints.getComponent(v, j))) w += weights.getComponent(v, j)
      return w > 0.55
    }
    const indices: number[] = []
    for (let i = 0; i < geo.index!.count; i += 3) {
      const ids = [0, 1, 2].map(j => geo.index!.getX(i + j))
      if (ids.every(keep)) indices.push(...ids)
    }
    const scale = 0.42 / rig.hold.scale
    const across = side === 'Right' ? 1 : -1
    const orient = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, across, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(across, 0, 0))
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(side === 'Left' && anchor.euler[0] > 1 ? -anchor.euler[0] : anchor.euler[0], -anchor.euler[1], -anchor.euler[2]))
    const origin = new THREE.Vector3(-across * (anchor.grip + 0.006 / rig.hold.scale), 0, -0.070 * scale).applyQuaternion(rotation)
      .add(new THREE.Vector3(-anchor.pos[0], anchor.pos[1], anchor.pos[2]))
    const direction = new THREE.Vector3(-anchor.forearm[0], anchor.forearm[1], anchor.forearm[2]).normalize()
    const elbowLength = wrist.distanceTo(elbow) * scale
    const bakedElbow = origin.clone().addScaledVector(direction, elbowLength)
    const forearmWeight = new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1)
    const forearmSlope = new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1)
    const protectedWrist = .055 * scale
    const bake = (pull: number, release = 0) => {
      poseFingers(source, side, pull, release)
      source.updateMatrixWorld(true); mesh.skeleton.update()
      const positions = new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count * 3), 3)
      const v = new THREE.Vector3()
      for (const i of new Set(indices)) {
        mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).applyMatrix4(basis)
        const forearmDistance = Math.max(0, -v.y)
        if (pull === 0 && release === 0) {
          // Keep the entire glove and the first 55 mm behind the wrist fixed at the grip.
          // Only the lower forearm can move toward the off-screen elbow anchor.
          const t = THREE.MathUtils.clamp((forearmDistance * scale - protectedWrist) / (elbowLength - protectedWrist), 0, 1)
          forearmWeight.setX(i, t * t * (3 - 2 * t))
          forearmSlope.setX(i, 6 * t * (1 - t) / (elbowLength - protectedWrist))
        }
        if (v.y < 0) v.y = 0
        v.multiplyScalar(scale).applyMatrix4(orient).applyQuaternion(rotation).add(origin).addScaledVector(direction, forearmDistance * scale)
        positions.setXYZ(i, v.x, v.y, v.z)
      }
      return positions
    }
    geo.setAttribute('position', bake(0))
    geo.setAttribute('forearmWeight', forearmWeight)
    geo.setAttribute('forearmSlope', forearmSlope)
    geo.morphAttributes.position = side === 'Right' ? [bake(1), bake(0, 1)] : [bake(0, 1)]
    geo.setIndex(indices)
    geo.deleteAttribute('skinWeight'); geo.deleteAttribute('skinIndex')
    geo.clearGroups(); geo.computeVertexNormals(); geo.computeBoundingSphere()
    const material = spartanMaterial(mesh.material as THREE.MeshStandardMaterial, team)
    const elbowDelta = { value: new THREE.Vector3() }
    const armor = armorOf(material)
    material.onBeforeCompile = shader => {
      if (armor) injectArmor(shader, armor)
      shader.uniforms.elbowDelta = elbowDelta
      shader.uniforms.forearmDirection = { value: direction }
      // Your own shields light your hands and forearms, the only part of you first person sees.
      injectShieldRim(shader, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float forearmWeight;
          attribute float forearmSlope;
          uniform vec3 elbowDelta;
          uniform vec3 forearmDirection;
        `)
        .replace('#include <defaultnormal_vertex>', `
          // Inverse-transpose of the longitudinal stretch keeps the armour lighting attached.
          vec3 elbowGradient = forearmDirection * forearmSlope;
          float elbowDeterminant = 1.0 + dot(elbowGradient, elbowDelta);
          objectNormal -= elbowGradient * dot(elbowDelta, objectNormal) / max(0.15, elbowDeterminant);
          #include <defaultnormal_vertex>
        `)
        .replace('#include <morphtarget_vertex>', `#include <morphtarget_vertex>
          transformed += elbowDelta * forearmWeight;
        `)
    }
    material.customProgramCacheKey = () => `spartan-viewmodel-elbow-v1${armor ? ':armor' : ''}`
    const part = new THREE.Mesh(geo, material)
    const cameraExit = new THREE.Vector3()
    part.onBeforeRender = (_renderer, _scene, camera) => {
      if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return
      // Anchor each elbow beyond the lower viewport edge, independent of weapon swings,
      // reload offsets and FOV. The baked wrist/finger vertices have zero displacement.
      const depth = .28
      const projection = camera.projectionMatrix.elements
      cameraExit.set(across * depth / Math.abs(projection[0]) * .70,
        -depth / Math.abs(projection[5]) - .16, -depth)
      camera.localToWorld(cameraExit)
      part.worldToLocal(cameraExit)
      elbowDelta.value.copy(cameraExit).sub(bakedElbow)
    }
    part.name = `spartan-${side.toLowerCase()}-forearm`
    part.frustumCulled = false
    const arm = new THREE.Group(); arm.add(part); group.add(arm)
    return {arm, part}
  }
  const right = make('Right', rig.right), left = make('Left', rig.left)
  const spare = buildSpareMag([0.03, 0.11, 0.052], 'red')
  spare.position.set(-rig.left.pos[0], rig.left.pos[1], rig.left.pos[2])
  spare.visible = false; left.arm.add(spare)
  return {group, rightArm:right.arm, leftArm:left.arm, rightHand:right.arm, leftHand:left.arm, spareMag:spare,
    setTrigger(pull) { if (right.part.morphTargetInfluences) right.part.morphTargetInfluences[0] = THREE.MathUtils.clamp(pull, 0, 1) },
    setRelease(r, l) {
      if (right.part.morphTargetInfluences) {
        right.part.morphTargetInfluences[1] = THREE.MathUtils.clamp(r, 0, 1)
        right.part.morphTargetInfluences[0] *= 1 - THREE.MathUtils.clamp(r, 0, 1)
      }
      if (left.part.morphTargetInfluences) left.part.morphTargetInfluences[0] = THREE.MathUtils.clamp(l, 0, 1)
    }}
}
