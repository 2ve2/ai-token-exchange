import { sql } from "drizzle-orm";
import {
	check,
	index,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { wallets } from "./wallets";

export const transactionTypeEnum = pgEnum("transaction_type", [
	"mint",
	"transfer",
	"purchase",
	"sale",
	"ai_usage",
	"escrow_lock",
	"escrow_release",
] as const);

export const transactionStatusEnum = pgEnum("transaction_status", [
	"pending",
	"completed",
	"failed",
] as const);

export const entryDirectionEnum = pgEnum("entry_direction", ["debit", "credit"] as const);

export const transactions = pgTable("transactions", {
	id: uuid("id").primaryKey().defaultRandom(),
	type: transactionTypeEnum("type").notNull(),
	status: transactionStatusEnum("status").notNull().default("pending"),
	// Nullable unique: multiple NULLs allowed by Postgres, duplicates rejected
	idempotencyKey: text("idempotency_key").unique(),
	metadata: jsonb("metadata").$type<Record<string, unknown>>(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntries = pgTable(
	"ledger_entries",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		transactionId: uuid("transaction_id")
			.notNull()
			.references(() => transactions.id, { onDelete: "cascade" }),
		walletId: uuid("wallet_id")
			.notNull()
			.references(() => wallets.id),
		direction: entryDirectionEnum("direction").notNull(),
		amount: numeric("amount", { precision: 38, scale: 8 }).notNull(),
		balanceAfter: numeric("balance_after", { precision: 38, scale: 8 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		// All entries for a given transaction (double-entry: 2+ rows)
		index("idx_ledger_entries_transaction_id").on(t.transactionId),

		// Wallet statement queries
		index("idx_ledger_entries_wallet_id").on(t.walletId),

		// Ledger invariant: entries always move a positive amount
		check("ledger_entries_amount_positive", sql`${t.amount} > 0`),
	],
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
