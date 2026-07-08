CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cost_curve" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"rarity" text NOT NULL,
	"base_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loot_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"entries" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rarity_tiers" (
	"code" text PRIMARY KEY NOT NULL,
	"base_rate" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weapon_upgrade_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cost_curve" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zone_loot" (
	"zone_id" text NOT NULL,
	"loot_table_id" text NOT NULL,
	CONSTRAINT "zone_loot_zone_id_loot_table_id_pk" PRIMARY KEY("zone_id","loot_table_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"item_def_id" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"refinement" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_facilities" (
	"player_id" uuid NOT NULL,
	"facility_id" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "player_facilities_player_id_facility_id_pk" PRIMARY KEY("player_id","facility_id")
);
--> statement-breakpoint
CREATE TABLE "player_save_state" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_wallets" (
	"player_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "player_wallets_player_id_currency_code_pk" PRIMARY KEY("player_id","currency_code"),
	CONSTRAINT "balance_non_negative" CHECK ("player_wallets"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "player_weapon_levels" (
	"player_id" uuid NOT NULL,
	"weapon_instance_id" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "player_weapon_levels_player_id_weapon_instance_id_pk" PRIMARY KEY("player_id","weapon_instance_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_auth_user_id_unique" UNIQUE("auth_user_id")
);
--> statement-breakpoint
CREATE TABLE "currency_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"delta" bigint NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text,
	"balance_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_code" integer,
	"response_body" jsonb,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_user_key" UNIQUE("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_facilities" ADD CONSTRAINT "player_facilities_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_save_state" ADD CONSTRAINT "player_save_state_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_wallets" ADD CONSTRAINT "player_wallets_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_weapon_levels" ADD CONSTRAINT "player_weapon_levels_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_player_item_idx" ON "inventory_items" USING btree ("player_id","item_def_id");--> statement-breakpoint
CREATE INDEX "ledger_player_created_idx" ON "currency_ledger" USING btree ("player_id","created_at");