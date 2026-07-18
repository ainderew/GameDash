import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { world } from '@/game/ecs/world';
import type { Entity } from '@sim/components';
import { sampleWithUnderrunPolicy } from '@sim/interp';
import { INTERP_UNDERRUN_DEADRECKON_MS, INTERP_UNDERRUN_HOLD_MS } from '@shared/net/constants';
import { MONSTER_ARCHETYPES, type MonsterArchetype } from '@shared/monsters';
import { ENTITY_KIND } from '@shared/net/snapshot';
import { gameNow } from '@/game/feel/time';
import { netClient } from '@/net/client';

/**
 * Renders the SERVER-AUTHORITATIVE shared world. In a networked session the server owns
 * expedition monsters/projectiles and the hub training dummy; the client only
 * PREDICTS its own avatar (stepSim authority 'local' spawns nothing), so this component is
 * the sole source of monster entities on the client:
 *
 *   each frame → reconcile the ECS against `netClient.remoteServerEntities()`:
 *     • a server id we haven't seen → add a monster ECS entity (the existing MonsterModels /
 *       MonsterHealthBars renderers draw it from the `monster` component),
 *     • sample its interp buffer ~100 ms in the past into the entity transform (replayed,
 *       never guessed — the same no-rubberband interpolation remote players use),
 *     • a server id that left the view (death / zone change) → remove its entity.
 *
 * The entities carry NO `velocity`, so the prediction step's movementSystem never integrates
 * them — their motion is pure snapshot replay. Mounted only when networked; unmount removes
 * every entity it owns so nothing leaks across a zone change or a disconnect.
 */
export const NetworkedWorld = () => {
  const owned = useRef(new Map<number, Entity>());

  useEffect(
    () => () => {
      for (const e of owned.current.values()) world.remove(e);
      owned.current.clear();
    },
    [],
  );

  useFrame(() => {
    const view = netClient.remoteServerEntities();
    const renderT = netClient.renderServerTime();
    const map = owned.current;

    for (const [id, se] of view) {
      const sample = sampleWithUnderrunPolicy(se.buffer, renderT, {
        holdMs: INTERP_UNDERRUN_HOLD_MS,
        deadReckonMs: INTERP_UNDERRUN_DEADRECKON_MS,
      });
      if (!sample) continue;
      let e = map.get(id);
      if (!e) {
        e = world.add(makeNetworkedEntity(se.kind, se.archetype, se.hp));
        map.set(id, e);
      }
      if (e.transform) {
        e.transform.position = [sample.pos[0], sample.pos[1], sample.pos[2]];
        e.transform.rotationY = sample.rotY;
      }
      if (e.health) e.health.current = se.hp;
      // Confirmed-hit flash (set from DamageDealt in client.ts) → the mesh reads these fields.
      if (se.flashUntil !== undefined && se.flashUntil > gameNow()) {
        e.hitFlashUntil = se.flashUntil;
        e.hitReactionStrength = se.flashStrength;
        e.hitFlashColor = se.flashStrength === 'heavy' ? [1, 0.35, 0.3] : [1, 1, 1];
      }
    }

    // Remove entities whose server id is gone from the view (killed / despawned / zone change).
    for (const [id, e] of map) {
      if (!view.has(id)) {
        world.remove(e);
        map.delete(id);
      }
    }
  });

  return null;
};

/** A minimal render-only entity for the existing renderers (MonsterModels / Projectiles /
 * Pickups): NO sim fields (no velocity/AI — the server owns behaviour; this is a replicated
 * pose). Parked out of sight until the first interp sample lands this frame. */
const makeNetworkedEntity = (
  kind: number,
  archetype: MonsterArchetype | undefined,
  hp: number,
): Entity => {
  if (kind === ENTITY_KIND.projectile) {
    // Projectiles.tsx renders by faction; the wire doesn't carry it, so show them as the
    // common case (monster shots). Player shots reading purple is a minor cosmetic miss.
    return {
      transform: { position: [0, -1000, 0], rotationY: 0 },
      projectile: true,
      faction: 'monster',
    };
  }
  if (kind === ENTITY_KIND.pickup) {
    // Pickups.tsx colors by tableId; the count is authoritative (materialTally), so default
    // the loose orbs to common. The real reward already landed in the HUD.
    return { transform: { position: [0, -1000, 0], rotationY: 0 }, pickup: { tableId: 'common' } };
  }
  const mk = archetype ?? 'chaser';
  const def = MONSTER_ARCHETYPES[mk];
  const max = def?.maxHealth ?? Math.max(1, hp);
  return {
    transform: { position: [0, -1000, 0], rotationY: 0 },
    health: { current: Math.max(1, hp || max), max },
    faction: 'monster',
    monster: mk,
    trainingDummy: mk === 'trainingDummy' ? true : undefined,
    radius: def?.radius ?? 0.6,
  };
};
