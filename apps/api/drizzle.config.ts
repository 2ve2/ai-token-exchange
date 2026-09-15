import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL environment variable is not set");
}

export default defineConfig({
	dialect: "postgresql",
	schema: [
		"./src/db/schema/users.ts",
		"./src/db/schema/wallets.ts",
		"./src/db/schema/transactions.ts",
		"./src/db/schema/listings.ts",
		"./src/db/schema/ai_usage.ts",
		"./src/db/schema/relations.ts",
	],
	out: "./src/db/migrations",
	dbCredentials: {
		url: process.env.DATABASE_URL,
	},
});
