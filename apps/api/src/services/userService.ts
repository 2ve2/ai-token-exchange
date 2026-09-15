import { eq } from "drizzle-orm";
import { db } from "@/db";
import { type User, users, wallets } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { generateWalletId } from "@/lib/wallet-id";
import type { RegisterInput } from "@/types/schemas";

const MAX_WALLET_ID_ATTEMPTS = 5;

function isWalletIdCollision(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "23505" &&
		"constraint" in error &&
		typeof (error as { constraint?: unknown }).constraint === "string" &&
		(error as { constraint: string }).constraint.includes("wallet_id")
	);
}

export interface PublicUser {
	id: string;
	email: string;
	username: string;
	createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
	return {
		id: user.id,
		email: user.email,
		username: user.username,
		createdAt: user.createdAt,
	};
}

export const userService = {
	/**
	 * Create a user and their wallet in a single transaction.
	 * On the (astronomically rare) wallet_id collision the whole
	 * transaction is retried with a fresh code — registration never
	 * fails because of a collision.
	 */
	async registerWithWallet(input: RegisterInput): Promise<{ user: User; walletId: string }> {
		const passwordHash = await hashPassword(input.password);

		for (let attempt = 1; attempt <= MAX_WALLET_ID_ATTEMPTS; attempt++) {
			const walletId = generateWalletId();
			try {
				return await db.transaction(async (tx) => {
					const [user] = await tx
						.insert(users)
						.values({
							email: input.email,
							username: input.username,
							passwordHash,
						})
						.returning();

					if (!user) {
						throw new Error("Failed to create user");
					}

					await tx.insert(wallets).values({
						userId: user.id,
						walletId,
						balance: "0",
					});

					return { user, walletId };
				});
			} catch (error) {
				if (isWalletIdCollision(error) && attempt < MAX_WALLET_ID_ATTEMPTS) {
					continue;
				}
				throw error;
			}
		}

		throw new Error("Failed to generate a unique wallet_id");
	},

	async getUserByEmail(email: string): Promise<User | null> {
		const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
		return user ?? null;
	},

	async getUserById(id: string): Promise<User | null> {
		const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
		return user ?? null;
	},
};
