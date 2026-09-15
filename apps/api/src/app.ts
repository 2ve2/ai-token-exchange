import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { db } from "@/db";
import { errorResponse, successResponse } from "@/lib/response-helpers";
import { authMiddleware } from "@/middleware/auth";
import { handleError } from "@/middleware/error-handler";
import { aiRoutes } from "@/routes/ai";
import { authRoutes } from "@/routes/auth";
import { marketplaceRoutes } from "@/routes/marketplace";
import { transferRoutes } from "@/routes/transfer";
import { walletRoutes } from "@/routes/wallet";

const app = new Hono();

app.onError(handleError);

app.use("*", cors());
app.use("*", logger());
app.use("*", prettyJSON());

// Protected routes (middleware applied before mounting)
app.use("/wallet/*", authMiddleware);
app.use("/transfer/*", authMiddleware);
app.use("/ai/*", authMiddleware);

// Marketplace: browsing (GET) is public, every mutation is protected
app.on("POST", "/marketplace/*", authMiddleware);

// Liveness check
app.get("/", (c) => successResponse(c, { timestamp: new Date().toISOString() }, "API is running"));

// Readiness check: verifies database connectivity
app.get("/health", async (c) => {
	const startedAt = performance.now();
	try {
		await db.execute(sql`select 1`);
		return successResponse(
			c,
			{
				database: "connected",
				latencyMs: Math.round(performance.now() - startedAt),
			},
			"Healthy",
		);
	} catch (error) {
		console.error("Health check failed:", error);
		return errorResponse(c, "Database unreachable", 503, "DATABASE_UNREACHABLE");
	}
});

// Routes
app.route("/auth", authRoutes);
app.route("/wallet", walletRoutes);
app.route("/transfer", transferRoutes);
app.route("/marketplace", marketplaceRoutes);
app.route("/ai", aiRoutes);

// Named export only (no default export): a default export would let
// `bun src/app.ts` auto-serve without going through src/server.ts.
export { app };
