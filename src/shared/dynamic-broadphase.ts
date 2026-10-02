import { Body, SAPBroadphase, type World } from 'cannon-es'

/** Static scenery cannot collide with itself. Keep SAP's ray queries, but generate
 * contact pairs from moving bodies so a scenery-heavy world avoids an O(n²) sweep. */
export class DynamicBroadphase extends SAPBroadphase {
  private readonly moving: Body[] = []
  private readonly fixed: Body[] = []

  override collisionPairs(world: World, pairs1: Body[], pairs2: Body[]): void {
    this.moving.length = this.fixed.length = 0
    for (const body of world.bodies) {
      if (body.type === Body.STATIC) this.fixed.push(body)
      else this.moving.push(body)
    }
    for (let i = 0; i < this.moving.length; i++) {
      const body = this.moving[i]
      for (const fixed of this.fixed) {
        if (this.needBroadphaseCollision(body, fixed)) this.intersectionTest(body, fixed, pairs1, pairs2)
      }
      for (let j = i + 1; j < this.moving.length; j++) {
        const other = this.moving[j]
        if (this.needBroadphaseCollision(body, other)) this.intersectionTest(body, other, pairs1, pairs2)
      }
    }
  }
}
