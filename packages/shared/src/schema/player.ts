import {
  pgTable,
  text,
  bigint,
  integer,
  jsonb,
  uuid,
  timestamp,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Per-player state. Money lives in real columns with CHECK constraints (never JSONB);
 * `player_save_state.data` holds ONLY non-authoritative settings/cosmetics.
 */

export const players = pgTable('players', {
  id: uuid('id').primaryKey().defaultRandom(),
  authUserId: uuid('auth_user_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const playerWallets = pgTable(
  'player_wallets',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    currencyCode: text('currency_code').notNull(),
    balance: bigint('balance', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.currencyCode] }),
    check('balance_non_negative', sql`${t.balance} >= 0`),
  ],
);

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    itemDefId: text('item_def_id').notNull(),
    qty: integer('qty').notNull().default(1),
    level: integer('level').notNull().default(1),
    refinement: integer('refinement').notNull().default(0),
  },
  (t) => [index('inventory_player_item_idx').on(t.playerId, t.itemDefId)],
);

export const playerFacilities = pgTable(
  'player_facilities',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    facilityId: text('facility_id').notNull(),
    level: integer('level').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.facilityId] })],
);

export const playerWeaponLevels = pgTable(
  'player_weapon_levels',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    weaponInstanceId: text('weapon_instance_id').notNull(),
    level: integer('level').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.weaponInstanceId] })],
);

/** Non-authoritative blob: settings, cosmetics, tutorial flags. No money here. */
export const playerSaveState = pgTable('player_save_state', {
  playerId: uuid('player_id')
    .primaryKey()
    .references(() => players.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
