import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { ERROR_MESSAGES } from "@/constants/errors";
import {
	findPostgresError,
	getHttpStatusForDatabaseError,
	getUserFriendlyMessage,
	parseDatabaseError,
} from "@/lib/database-errors";
import {
	databaseErrorResponse,
	errorResponse,
	internalErrorResponse,
	validationErrorResponse,
} from "@/lib/response-helpers";

/**
 * Central error handler wired into app.onError: maps HTTP exceptions,
 * Zod validation errors, and database errors to the standard response shape.
 */
export function handleError(err: unknown, c: Context): Response {
	console.error("Error:", err);

	// Handle HTTP exceptions (thrown by our application)
	if (err instanceof HTTPException) {
		return errorResponse(c, err.message, err.status);
	}

	// Handle Zod validation errors
	if (err instanceof ZodError) {
		const [firstError] = err.issues;
		if (!firstError) {
			return validationErrorResponse(c, "Invalid input");
		}
		const fieldName = firstError.path.join(".");
		return validationErrorResponse(c, firstError.message, fieldName);
	}

	// Handle database errors (unwrap Drizzle wrappers via the cause chain)
	if (err instanceof Error) {
		const pgError = findPostgresError(err);
		if (pgError) {
			return databaseErrorResponse(c, pgError);
		}

		const dbError = parseDatabaseError(err);
		const statusCode = getHttpStatusForDatabaseError(dbError);
		const userMessage = getUserFriendlyMessage(dbError);

		console.error("Database error details:", {
			code: dbError.code,
			constraint: dbError.constraint,
			detail: dbError.detail,
			originalMessage: err.message,
		});

		return errorResponse(c, userMessage, statusCode, dbError.code);
	}

	// Fallback for unknown errors
	console.error("Unknown error type:", err);
	return internalErrorResponse(c, ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
}
