import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { transactions } from "./transactions";
import { users } from "./users";

export const aiUsageLogs = pgTable(
	"ai_usage_logs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		transactionId: uuid("transaction_id")
			.notNull()
			.references(() => transactions.id),
		model: text("model").notNull(),
		tokensUsed: integer("tokens_used").notNull(),
		requestId: text("request_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		// User usage history
		index("idx_ai_usage_logs_user_id").on(t.userId),

		// Join usage logs to their billing transaction
		index("idx_ai_usage_logs_transaction_id").on(t.transactionId),
	],
);

export type AiUsageLog = typeof aiUsageLogs.$inferSelect;
export type NewAiUsageLog = typeof aiUsageLogs.$inferInsert;
