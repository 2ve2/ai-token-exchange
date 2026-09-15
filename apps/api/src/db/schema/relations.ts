import { relations } from "drizzle-orm";
import { aiUsageLogs } from "./ai_usage";
import { listings } from "./listings";
import { ledgerEntries, transactions } from "./transactions";
import { users } from "./users";
import { wallets } from "./wallets";

export const usersRelations = relations(users, ({ many }) => ({
	wallets: many(wallets),
	listings: many(listings),
	aiUsageLogs: many(aiUsageLogs),
}));

export const walletsRelations = relations(wallets, ({ one, many }) => ({
	user: one(users, { fields: [wallets.userId], references: [users.id] }),
	ledgerEntries: many(ledgerEntries),
}));

export const transactionsRelations = relations(transactions, ({ many }) => ({
	ledgerEntries: many(ledgerEntries),
	aiUsageLogs: many(aiUsageLogs),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
	transaction: one(transactions, {
		fields: [ledgerEntries.transactionId],
		references: [transactions.id],
	}),
	wallet: one(wallets, {
		fields: [ledgerEntries.walletId],
		references: [wallets.id],
	}),
}));

export const listingsRelations = relations(listings, ({ one }) => ({
	seller: one(users, { fields: [listings.sellerId], references: [users.id] }),
}));

export const aiUsageLogsRelations = relations(aiUsageLogs, ({ one }) => ({
	user: one(users, { fields: [aiUsageLogs.userId], references: [users.id] }),
	transaction: one(transactions, {
		fields: [aiUsageLogs.transactionId],
		references: [transactions.id],
	}),
}));
