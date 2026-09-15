import { sql } from "drizzle-orm";
import { check, index, numeric, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const listingStatusEnum = pgEnum("listing_status", [
	"active",
	"fulfilled",
	"cancelled",
] as const);

export const listings = pgTable(
	"listings",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		sellerId: uuid("seller_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		amount: numeric("amount", { precision: 38, scale: 8 }).notNull(),
		pricePerToken: numeric("price_per_token", { precision: 38, scale: 8 }).notNull(),
		status: listingStatusEnum("status").notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		// Seller's own listings
		index("idx_listings_seller_id").on(t.sellerId),

		// Marketplace feed: active listings ordered by recency
		index("idx_listings_status_created_at").on(t.status, t.createdAt),

		check("listings_amount_positive", sql`${t.amount} > 0`),
	],
);

export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
