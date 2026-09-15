import bcrypt from "bcryptjs";
import { sign, verify } from "hono/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";
import { env } from "@/config/env";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function bcryptRounds(): number {
	// Cheap rounds in tests; full strength otherwise
	return process.env.NODE_ENV === "test" ? 4 : 12;
}

export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, bcryptRounds());
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return bcrypt.compare(password, hash);
}

export async function signToken(userId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }, env.JWT_SECRET, "HS256");
}

export async function verifyToken(token: string): Promise<JWTPayload> {
	return verify(token, env.JWT_SECRET, "HS256");
}
