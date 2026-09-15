import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const wallets = pgTable(
	"wallets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		// Short human-shareable transfer identifier (distinct from the UUID pk)
		walletId: text("wallet_id").notNull().unique(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		balance: numeric("balance", { precision: 38, scale: 8 }).notNull().default("0"),
		// Optimistic locking version, bumped on every balance change
		version: integer("version").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		// Look up wallets by owner
		index("idx_wallets_user_id").on(t.userId),

		// Ledger invariant: balance can never go negative
		check("wallets_balance_non_negative", sql`${t.balance} >= 0`),
	],
);

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
