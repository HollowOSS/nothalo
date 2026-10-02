import * as THREE from 'three'

type Node = { box: THREE.Box3; triangles?: number[]; left?: Node; right?: Node }

/** Fixed, single-material map meshes use a triangle tree; Three still computes the
 * final intersection, UVs and normals. Rendering and collision geometry stay identical. */
export function accelerateStaticMesh(mesh: THREE.Mesh): void {
  if (Array.isArray(mesh.material) || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return
  const source = mesh.geometry, position = source.attributes.position, sourceIndex = source.index
  const count = sourceIndex?.count ?? position.count
  if (count < 300) return
  const boxes: THREE.Box3[] = [], triangles: number[] = []
  const point = new THREE.Vector3()
  const start = Math.max(0, source.drawRange.start), end = Math.min(count, start + source.drawRange.count)
  for (let offset = start; offset + 2 < end; offset += 3) {
    const box = new THREE.Box3()
    for (let i = 0; i < 3; i++) box.expandByPoint(point.fromBufferAttribute(position, sourceIndex ? sourceIndex.getX(offset + i) : offset + i))
    boxes[offset / 3] = box; triangles.push(offset / 3)
  }
  const build = (list: number[]): Node => {
    const box = new THREE.Box3()
    for (const id of list) box.union(boxes[id])
    if (list.length <= 24) return { box, triangles: list }
    const size = box.getSize(new THREE.Vector3())
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
    list.sort((a, b) => boxes[a].min[axis] + boxes[a].max[axis] - boxes[b].min[axis] - boxes[b].max[axis])
    const middle = list.length >> 1
    return { box, left: build(list.slice(0, middle)), right: build(list.slice(middle)) }
  }
  if (!triangles.length) return
  const tree = build(triangles)
  const geometry = new THREE.BufferGeometry()
  for (const [key, attribute] of Object.entries(source.attributes)) geometry.setAttribute(key, attribute)
  source.computeBoundingSphere(); source.computeBoundingBox()
  geometry.boundingSphere = source.boundingSphere; geometry.boundingBox = source.boundingBox
  const indices = new Uint32Array(count)
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const proxy = new THREE.Mesh(geometry, mesh.material), inverse = new THREE.Matrix4(), ray = new THREE.Ray()
  const candidates: number[] = [], hits: THREE.Intersection[] = []
  mesh.raycast = (raycaster, intersections) => {
    inverse.copy(mesh.matrixWorld).invert(); ray.copy(raycaster.ray).applyMatrix4(inverse)
    candidates.length = 0
    const visit = (node: Node): void => {
      if (!ray.intersectsBox(node.box)) return
      if (node.triangles) for (const id of node.triangles) { if (ray.intersectsBox(boxes[id])) candidates.push(id) }
      else { visit(node.left!); visit(node.right!) }
    }
    visit(tree)
    if (!candidates.length) return
    candidates.sort((a, b) => a - b)
    for (let i = 0; i < candidates.length; i++) for (let corner = 0; corner < 3; corner++) {
      const offset = candidates[i] * 3 + corner
      indices[i * 3 + corner] = sourceIndex ? sourceIndex.getX(offset) : offset
    }
    geometry.setDrawRange(0, candidates.length * 3)
    proxy.matrixWorld.copy(mesh.matrixWorld); proxy.material = mesh.material as THREE.Material
    hits.length = 0; proxy.raycast(raycaster, hits)
    for (const hit of hits) { hit.faceIndex = candidates[hit.faceIndex!]; hit.object = mesh; intersections.push(hit) }
  }
}
