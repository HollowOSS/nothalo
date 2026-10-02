import * as THREE from 'three'

type Entry = { box: THREE.Box3; matrix: THREE.Matrix4; id: number }
type Node = { box: THREE.Box3; entries?: Entry[]; left?: Node; right?: Node }

function build(entries: Entry[]): Node {
  const box = new THREE.Box3()
  for (const entry of entries) box.union(entry.box)
  if (entries.length <= 8) return { box, entries }
  const size = box.getSize(new THREE.Vector3())
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
  entries.sort((a, b) => a.box.min[axis] + a.box.max[axis] - b.box.min[axis] - b.box.max[axis])
  const middle = entries.length >> 1
  return { box, left: build(entries.slice(0, middle)), right: build(entries.slice(middle)) }
}

/** Index fixed boulder transforms once. Narrow-phase still uses Three's exact mesh
 * raycast, with the same materials, face sidedness, distance and instance IDs. */
export function accelerateStaticInstances(mesh: THREE.InstancedMesh): void {
  mesh.updateWorldMatrix(true, false)
  mesh.geometry.computeBoundingBox()
  const entries: Entry[] = []
  for (let id = 0; id < mesh.count; id++) {
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(id, matrix)
    matrix.premultiply(mesh.matrixWorld)
    entries.push({ matrix, id, box: mesh.geometry.boundingBox!.clone().applyMatrix4(matrix) })
  }
  if (!entries.length) return
  const tree = build(entries)
  const proxy = new THREE.Mesh(mesh.geometry, mesh.material)
  const hits: THREE.Intersection[] = []
  const point = new THREE.Vector3()
  mesh.raycast = (raycaster, intersections) => {
    const visit = (node: Node): void => {
      if (!raycaster.ray.intersectBox(node.box, point)) return
      // A ray starting inside the box exits beyond far but may still hit geometry inside.
      if (!node.box.containsPoint(raycaster.ray.origin) && point.distanceToSquared(raycaster.ray.origin) > raycaster.far ** 2) return
      if (node.entries) {
        for (const entry of node.entries) {
          if (!raycaster.ray.intersectsBox(entry.box)) continue
          proxy.matrixWorld.copy(entry.matrix)
          hits.length = 0
          proxy.raycast(raycaster, hits)
          for (const hit of hits) { hit.instanceId = entry.id; hit.object = mesh; intersections.push(hit) }
        }
      } else { visit(node.left!); visit(node.right!) }
    }
    visit(tree)
  }
}
