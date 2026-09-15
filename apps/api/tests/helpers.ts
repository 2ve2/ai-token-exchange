import { eq } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";
import { wallets } from "../src/db/schema";
import { normalizeAmount } from "../src/lib/money";

let counter = 0;
export const unique = () => `${Date.now()}${counter++}${Math.random().toString(36).slice(2, 8)}`;

export interface TestUser {
	token: string;
	walletId: string;
}

export async function createUser(): Promise<TestUser> {
	const id = unique();
	const email = `t${id}@test.dev`;
	const username = `t${id}`;

	const reg = await app.request("/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, username, password: "test-password-1" }),
	});
	const regJson = (await reg.json()) as {
		result: { user: { email: string }; wallet: { wallet_id: string } };
	};

	const login = await app.request("/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: "test-password-1" }),
	});
	const loginJson = (await login.json()) as { result: { token: string } };

	return { token: loginJson.result.token, walletId: regJson.result.wallet.wallet_id };
}

/**
 * Direct DB funding for test setup (the mint/admin endpoint does not
 * exist yet).
 */
export async function fund(walletId: string, balance: string): Promise<void> {
	await db.update(wallets).set({ balance }).where(eq(wallets.walletId, walletId));
}

export async function getBalance(walletId: string): Promise<string> {
	const wallet = await db.query.wallets.findFirst({
		where: eq(wallets.walletId, walletId),
	});
	return normalizeAmount(wallet?.balance ?? "0");
}

export async function authJson(
	token: string,
	path: string,
	method: "POST" | "GET",
	body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await app.request(path, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
