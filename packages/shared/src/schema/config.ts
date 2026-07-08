import { pgTable, text, numeric, jsonb, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Config / reference tables — game-designer-owned data (seeded, not per-player).
 * These define the economy's shape: currencies, rarities, items, cost curves.
 */

export type CurrencyKind = 'soft' | 'premium' | 'material';

export const currencies = pgTable('currencies', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<CurrencyKind>().notNull(),
});

export const rarityTiers = pgTable('rarity_tiers', {
  code: text('code').primaryKey(), // 'R3' | 'R4' | 'R5'
  baseRate: numeric('base_rate').notNull(),
});

export const itemDefs = pgTable('item_defs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // 'weapon' | 'gear' | 'character' | 'material'
  rarity: text('rarity').notNull(),
  baseStats: jsonb('base_stats').$type<Record<string, number>>().default({}).notNull(),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
});

/** Cost curve: level → { currencyCode → amount } required to reach that level. */
export type CostCurve = Record<string, Record<string, number>>;

export const facilityDefs = pgTable('facility_defs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  costCurve: jsonb('cost_curve').$type<CostCurve>().notNull(),
});

export const weaponUpgradeDefs = pgTable('weapon_upgrade_defs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  costCurve: jsonb('cost_curve').$type<CostCurve>().notNull(),
});

/** A loot table: weighted entries the server rolls against (server-side RNG). */
export type LootEntry = { currencyCode: string; min: number; max: number; weight: number };

export const lootTables = pgTable('loot_tables', {
  id: text('id').primaryKey(),
  entries: jsonb('entries').$type<LootEntry[]>().notNull(),
});

/** Which currencies a zone's loot tables can grant (join table, forward-looking). */
export const zoneLoot = pgTable(
  'zone_loot',
  {
    zoneId: text('zone_id').notNull(),
    lootTableId: text('loot_table_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.zoneId, t.lootTableId] })],
);
