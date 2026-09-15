import { createMiddleware } from "hono/factory";
import { verifyToken } from "@/lib/auth";
import { unauthorizedResponse } from "@/lib/response-helpers";
import { userService } from "@/services/userService";
import type { AppEnv } from "@/types/context";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return unauthorizedResponse(c, "Missing bearer token");
	}

	try {
		const payload = await verifyToken(header.slice(7));
		const userId = payload.sub;
		if (typeof userId !== "string") {
			return unauthorizedResponse(c, "Invalid token");
		}

		const user = await userService.getUserById(userId);
		if (!user) {
			return unauthorizedResponse(c, "User no longer exists");
		}

		c.set("user", user);
	} catch {
		return unauthorizedResponse(c, "Invalid or expired token");
	}

	await next();
});
