import { Hono } from "hono";
import { signToken, verifyPassword } from "@/lib/auth";
import { normalizeAmount } from "@/lib/money";
import { errorResponse, successResponse, validationErrorResponse } from "@/lib/response-helpers";
import { toPublicUser, userService } from "@/services/userService";
import { LoginSchema, RegisterSchema } from "@/types/schemas";

const app = new Hono();

/**
 * POST /auth/register
 * Create a user + wallet (single transaction), returns the user and wallet_id
 */
app.post("/register", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = RegisterSchema.safeParse(body);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return validationErrorResponse(c, first?.message ?? "Invalid input", first?.path.join("."));
	}

	const { user, walletId } = await userService.registerWithWallet(parsed.data);

	return successResponse(
		c,
		{
			user: toPublicUser(user),
			wallet: { wallet_id: walletId, balance: normalizeAmount("0") },
		},
		"Registration successful",
		201,
	);
});

/**
 * POST /auth/login
 * Verify credentials, return a JWT
 */
app.post("/login", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = LoginSchema.safeParse(body);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return validationErrorResponse(c, first?.message ?? "Invalid input", first?.path.join("."));
	}

	const user = await userService.getUserByEmail(parsed.data.email);
	// passwordHash must be a real bcrypt hash: guards the unloginable
	// system escrow account (seeded with "!unloginable")
	const hasUsableHash = user?.passwordHash.startsWith("$2") ?? false;
	if (!user || !hasUsableHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
		return errorResponse(c, "Invalid email or password", 401, "INVALID_CREDENTIALS");
	}

	const token = await signToken(user.id);

	return successResponse(c, { token, user: toPublicUser(user) }, "Login successful");
});

export { app as authRoutes };
