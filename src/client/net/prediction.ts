import { advanceSwordLunge, type SwordLunge } from '../../shared/sword-lunge.ts'
import { step, cloneState, type PlayerInput, type PlayerState } from '../../shared/movement.ts'
import { stepVehicle, cloneVehicleState, vehicleDisagreement, type VehicleKind, type VehicleInput, type VehicleState } from '../../shared/vehicle-sim.ts'
import { NET } from '../../shared/constants.ts'

/**
 * Client-side prediction with server reconciliation.
 *
 * Whatever the local player is driving — their own legs or a vehicle — moves the instant a key
 * goes down, through the same shared step the server will run on the same input. Every step is
 * remembered along with the state it produced. When a snapshot arrives the server's state is
 * compared against what we had after the same input; if they agree, nothing happens. If they
 * disagree — someone shot us into a stumble, a frame was dropped, we clipped a rock a tick
 * apart — the server's state is adopted and every input it has not yet seen is replayed on
 * top, which lands us where the server will agree we are without waiting a round trip.
 */

interface Recorded<S, I> {
  seq: number
  input: I
  after: S
}

/** Above this the states are held to disagree. Well under a millimetre, so only real events count. */
const TOLERANCE = 1e-3

export class Replay<S, I> {
  private readonly history: Recorded<S, I>[] = []
  /** Distance of the last correction applied, for debugging and for the HUD if it wants it. */
  lastCorrection = 0
  corrections = 0

  constructor(
    private readonly stepFn: (state: S, input: I) => void,
    private readonly clone: (state: S) => S,
    private readonly disagree: (a: S, b: S) => number,
  ) {}

  /** Call after the step has been applied for this input. */
  record(seq: number, input: I, state: S): void {
    this.history.push({ seq, input, after: this.clone(state) })
    if (this.history.length > NET.inputBufferSize * 2) this.history.splice(0, this.history.length - NET.inputBufferSize * 2)
  }

  forget(): void {
    this.history.length = 0
  }

  /**
   * Fold a server state for input `ackSeq` (16-bit) into `state`, replaying newer inputs.
   * Returns true if a correction was applied.
   */
  reconcile(state: S, server: S, ackSeq: number): boolean {
    let index = -1
    for (let i = this.history.length - 1; i >= 0; i--) {
      if ((this.history[i].seq & 0xffff) === ackSeq) { index = i; break }
    }

    if (index < 0) {
      // Nothing to compare against: before our first input reaches the server, or after a
      // stall long enough to have forgotten. The server is right by definition.
      if (this.history.length === 0 || this.disagree(state, server) > 2) {
        Object.assign(state as object, server)
        this.forget()
        return true
      }
      return false
    }

    const error = this.disagree(this.history[index].after, server)
    // Everything up to and including the acknowledged input is settled.
    this.history.splice(0, index + 1)
    if (error <= TOLERANCE) return false

    this.lastCorrection = error
    this.corrections++
    Object.assign(state as object, server)
    for (const r of this.history) {
      this.stepFn(state, r.input)
      r.after = this.clone(state)
    }
    return true
  }
}

function playerDisagreement(a: PlayerState, b: PlayerState): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    + Math.hypot(a.vx - b.vx, a.vy - b.vy, a.vz - b.vz) * 0.1
    + (a.onGround !== b.onGround ? 1 : 0)
}

interface PredictedPlayerInput extends PlayerInput { readonly swordLunge?: SwordLunge }

export class Prediction extends Replay<PlayerState, PredictedPlayerInput> {
  constructor() {
    super((s, i) => {
      step(s, i)
      // Each unacknowledged frame remembers its own pre-step dash remainder. Replay the
      // collision sweep on the corrected position instead of dropping the dash displacement.
      if (i.swordLunge) advanceSwordLunge(s, { ...i.swordLunge }, i.dt)
    }, cloneState, playerDisagreement)
  }

  /** lungeBefore is the dash state immediately before this frame's advanceSwordLunge. */
  override record(seq: number, input: PlayerInput, state: PlayerState, lungeBefore?: SwordLunge | null): void {
    super.record(seq, { ...input, swordLunge: lungeBefore ? { ...lungeBefore } : undefined }, state)
  }
}

export class VehiclePrediction extends Replay<VehicleState, VehicleInput> {
  constructor(kind: VehicleKind) {
    super((s, i) => stepVehicle(kind, s, i, 1 / NET.tickRate), cloneVehicleState, rigidVehicleDisagreement)
  }
}

/** An explosion can change angular/linear momentum without moving the body yet. */
export function rigidVehicleDisagreement(a: VehicleState, b: VehicleState): number {
  let error=vehicleDisagreement(a,b)
  if(Boolean(a.physicsReady)!==Boolean(b.physicsReady)) return error+3
  if(!a.physicsReady)return error
  const aq=[a.qx??0,a.qy??0,a.qz??0,a.qw??1],bq=[b.qx??0,b.qy??0,b.qz??0,b.qw??1]
  const denominator=Math.hypot(...aq)*Math.hypot(...bq)
  const dot=denominator ? Math.abs(aq.reduce((sum,n,i)=>sum+n*bq[i],0))/denominator : 0
  // q and -q represent the same orientation.
  error+=2*Math.acos(Math.min(1,dot))
  error+=Math.hypot((a.pvx??0)-(b.pvx??0),(a.pvy??0)-(b.pvy??0),(a.pvz??0)-(b.pvz??0))*.2
  error+=Math.hypot((a.avx??0)-(b.avx??0),(a.avy??0)-(b.avy??0),(a.avz??0)-(b.avz??0))*.2
  return error
}
