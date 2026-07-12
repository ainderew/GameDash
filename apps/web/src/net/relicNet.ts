import type { Vector3Tuple } from '@shared/types';
import type {
  RelicCaughtMessage,
  RelicDroppedMessage,
  RelicEruptedMessage,
  RelicFlightWire,
  RelicGroundedMessage,
  RelicLaunchedMessage,
  RelicPassFailedMessage,
  RelicVolatileDischargeMessage,
  RelicWelcomeState,
} from '@shared/net/messages';
import { events } from '@/game/ecs/world';

/**
 * CLIENT RELIC NETCODE STATE (Phase 5). The server owns the relic; this holds the
 * snapshot/event-derived truth a networked client renders from — phase, carrier, grounded
 * position, and the ACTIVE flight params (so every client reconstructs the identical arc via
 * `sampleRelicFlight`). No React, no three — the render layer (Phase 6 expedition wiring)
 * reads this each frame, exactly as `netStats`/`interp` are read.
 *
 * On each relic event it ALSO re-emits the matching sim `GameEvent` onto the client event
 * bus, so the existing receiver feedback (incoming arc, amber ring, panned chime, catch
 * juice) consumes the NETWORK feed with zero changes to the effects themselves — the seam the
 * receiver-feedback plan reserved ("the emit moves to the server-ack handler").
 */

export interface RelicNetState {
  /** The relic's entity id in the session world (from spawn/welcome), or null in the hub. */
  entityId: number | null;
  phase: 'carried' | 'inFlight' | 'grounded' | 'absent';
  /** Carrier avatar entity id (carried only). */
  carrierId: number | null;
  /** Latest known position (grounded/carrier point, or flight endpoint). */
  pos: Vector3Tuple;
  /** Active flight params (inFlight only) — the deterministic arc every client samples. */
  flight: RelicFlightWire | null;
  /** Latest server snapshot value (0..100). */
  corruption: number;
}

class RelicNet {
  readonly state: RelicNetState = {
    entityId: null,
    phase: 'absent',
    carrierId: null,
    pos: [0, 0, 0],
    flight: null,
    corruption: 0,
  };

  /** Our own avatar entity id — gates receiver-side feedback (chime only when WE receive). */
  private ownEntityId: number | null = null;

  setOwnEntity(id: number | null): void {
    this.ownEntityId = id;
  }

  /** Reset on disconnect / leaving the session. */
  reset(): void {
    this.state.entityId = null;
    this.state.phase = 'absent';
    this.state.carrierId = null;
    this.state.pos = [0, 0, 0];
    this.state.flight = null;
    this.state.corruption = 0;
  }

  /**
   * Seed a GROUNDED relic straight from a snapshot record. Entering the expedition via the
   * gate countdown sends no `welcome` and no `relicGrounded` event, so the snapshot's
   * kind=relic entity is the ONLY signal the relic exists — without this the relic is invisible
   * until someone catches it. Only acts while we have no relic (phase 'absent'); once we know
   * it, the reliable events own every transition (so this never fights a live flight/catch).
   */
  updateFromSnapshot(
    entityId: number,
    phase: RelicNetState['phase'],
    pos: Vector3Tuple,
    corruption: number,
  ): void {
    this.state.corruption = corruption;
    if (this.state.phase === 'absent') {
      this.state.entityId = entityId;
      this.state.phase = phase;
      this.state.carrierId = null;
      this.state.pos = [pos[0], pos[1], pos[2]];
    } else if (this.state.phase === 'grounded') {
      this.state.pos = [pos[0], pos[1], pos[2]];
    }
  }

  /** Seed from the welcome relic block (late join / reconnect reconstructs the live relic). */
  fromWelcome(relic: RelicWelcomeState | undefined): void {
    if (!relic) {
      this.reset();
      return;
    }
    this.state.entityId = relic.entityId;
    this.state.phase = relic.phase;
    this.state.carrierId = relic.carrierId ?? null;
    this.state.pos = [relic.pos[0], relic.pos[1], relic.pos[2]];
    this.state.flight = relic.flight ?? null;
    this.state.corruption = relic.corruption;
  }

  onLaunched(msg: RelicLaunchedMessage): void {
    this.state.phase = 'inFlight';
    this.state.carrierId = null;
    this.state.flight = msg.flight;
    this.state.pos = [...msg.flight.from];
    // Drive receiver + world feedback off the network launch (arc/whoosh, chime when ours).
    events.emit({
      type: 'RelicPassLaunched',
      toLocalPlayer: msg.flight.targetId !== undefined && msg.flight.targetId === this.ownEntityId,
      from: [msg.flight.from[0], msg.flight.from[1], msg.flight.from[2]],
    });
    events.emit({
      type: 'RelicThrown',
      holderId: msg.flight.throwerId,
      targetId: msg.flight.targetId,
    });
  }

  onCaught(msg: RelicCaughtMessage): void {
    this.state.phase = 'carried';
    this.state.carrierId = msg.carrierId;
    this.state.flight = null;
    this.state.pos = [msg.pos[0], msg.pos[1], msg.pos[2]];
    this.state.corruption = msg.corruption;
    events.emit({
      type: 'RelicCaught',
      byLocalPlayer: msg.carrierId === this.ownEntityId,
      position: [msg.pos[0], msg.pos[1], msg.pos[2]],
    });
  }

  onPassFailed(msg: RelicPassFailedMessage): void {
    events.emit({
      type: 'RelicPassFailed',
      position: [msg.pos[0], msg.pos[1], msg.pos[2]],
      reason: msg.reason,
    });
  }

  onDropped(msg: RelicDroppedMessage): void {
    this.state.pos = [msg.pos[0], msg.pos[1], msg.pos[2]];
  }

  onGrounded(msg: RelicGroundedMessage): void {
    this.state.phase = 'grounded';
    this.state.carrierId = null;
    this.state.flight = null;
    this.state.pos = [msg.pos[0], msg.pos[1], msg.pos[2]];
  }

  onErupted(msg: RelicEruptedMessage): void {
    this.state.corruption = 0;
    events.emit({
      type: 'RelicErupted',
      holderId: msg.holderId,
      position: [msg.pos[0], msg.pos[1], msg.pos[2]],
    });
  }

  onVolatileDischarge(msg: RelicVolatileDischargeMessage): void {
    events.emit({
      type: 'RelicVolatileDischarge',
      holderId: msg.holderId,
      position: [msg.pos[0], msg.pos[1], msg.pos[2]],
      radius: msg.radius,
      tierIndex: msg.tierIndex,
    });
  }
}

/** Client singleton — one relic per session, like the ECS world. */
export const relicNet = new RelicNet();
