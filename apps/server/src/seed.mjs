import 'dotenv/config';
import postgres from 'postgres';

// Seeds designer-owned config data. Idempotent (ON CONFLICT DO NOTHING).
const sql = postgres(process.env.DIRECT_URL, { prepare: false });

const currencies = [
  ['coins', 'Coins', 'soft'],
  ['gems', 'Gems', 'premium'],
  ['common', 'Common Material', 'material'],
  ['rare', 'Rare Material', 'material'],
];

const rarities = [
  ['R3', '0.50'],
  ['R4', '0.30'],
  ['R5', '0.20'],
];

// Cost curve: level -> { currency -> amount } to REACH that level.
const forgeCurve = { 2: { common: 10 }, 3: { common: 25, rare: 2 }, 4: { common: 60, rare: 6 } };
const swordCurve = { 2: { common: 8 }, 3: { common: 20, rare: 1 }, 4: { common: 45, rare: 4 } };

for (const [code, name, kind] of currencies) {
  await sql`insert into currencies (code, name, kind) values (${code}, ${name}, ${kind})
            on conflict (code) do nothing`;
}
for (const [code, rate] of rarities) {
  await sql`insert into rarity_tiers (code, base_rate) values (${code}, ${rate})
            on conflict (code) do nothing`;
}
await sql`insert into facility_defs (id, name, cost_curve)
          values ('forge', 'Forge', ${sql.json(forgeCurve)})
          on conflict (id) do nothing`;
await sql`insert into weapon_upgrade_defs (id, name, cost_curve)
          values ('basic_sword', 'Basic Sword', ${sql.json(swordCurve)})
          on conflict (id) do nothing`;

const counts = await sql`select
  (select count(*) from currencies) as currencies,
  (select count(*) from rarity_tiers) as rarities,
  (select count(*) from facility_defs) as facilities,
  (select count(*) from weapon_upgrade_defs) as weapons`;
console.log('Seeded:', counts[0]);
await sql.end();
