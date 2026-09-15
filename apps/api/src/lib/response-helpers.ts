import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Standard API response format
 */
export interface ApiResponse<T = unknown> {
	status: boolean;
	message?: string;
	result?: T;
	error?: string;
	code?: string;
}

/**
 * Success response helper
 */
export function successResponse<T>(
	c: Context,
	result: T,
	message?: string,
	statusCode: ContentfulStatusCode = 200,
): Response {
	const response: ApiResponse<T> = {
		status: true,
		result,
	};

	if (message) {
		response.message = message;
	}

	return c.json(response, statusCode);
}

/**
 * Error response helper
 */
export function errorResponse(
	c: Context,
	error: string,
	statusCode: ContentfulStatusCode = 400,
	code?: string,
): Response {
	const response: ApiResponse = {
		status: false,
		error,
	};

	if (code) {
		response.code = code;
	}

	return c.json(response, statusCode);
}

/**
 * Not found response helper
 */
export function notFoundResponse(c: Context, message: string = "Resource not found"): Response {
	return errorResponse(c, message, 404, "NOT_FOUND");
}

/**
 * Validation error response helper
 */
export function validationErrorResponse(c: Context, message: string, field?: string): Response {
	const response: ApiResponse & { field?: string } = {
		status: false,
		error: "Validation failed",
		message,
		code: "VALIDATION_ERROR",
	};

	if (field) {
		response.code = `VALIDATION_ERROR_${field.toUpperCase()}`;
		response.field = field;
	}

	return c.json(response, 400);
}

/**
 * Unauthorized response helper
 */
export function unauthorizedResponse(
	c: Context,
	message: string = "Unauthorized access",
): Response {
	return errorResponse(c, message, 401, "UNAUTHORIZED");
}

/**
 * Forbidden response helper
 */
export function forbiddenResponse(c: Context, message: string = "Access forbidden"): Response {
	return errorResponse(c, message, 403, "FORBIDDEN");
}

/**
 * Conflict response helper (for duplicate resources)
 */
export function conflictResponse(
	c: Context,
	message: string = "Resource already exists",
): Response {
	return errorResponse(c, message, 409, "CONFLICT");
}

/**
 * Internal server error response helper
 */
export function internalErrorResponse(
	c: Context,
	message: string = "Internal server error",
): Response {
	return errorResponse(c, message, 500, "INTERNAL_ERROR");
}

/**
 * Maps a unique-constraint name to a user-facing message
 */
function uniqueViolationMessage(constraint?: string): string {
	if (constraint?.includes("wallet_id")) {
		return "A wallet with this ID already exists";
	}
	if (constraint?.includes("idempotency_key")) {
		return "Duplicate request";
	}
	if (constraint?.includes("email")) {
		return "Email address is already registered";
	}
	if (constraint?.includes("username")) {
		return "Username is already taken";
	}
	return "Resource already exists";
}

/**
 * Database error response helper
 */
export function databaseErrorResponse(c: Context, error: unknown): Response {
	if (typeof error === "object" && error !== null && "code" in error) {
		const dbError = error as {
			code: string;
			constraint?: string;
			constraint_name?: string;
			detail?: string;
		};
		// postgres.js exposes the PG wire field name (constraint_name)
		const constraint = dbError.constraint ?? dbError.constraint_name;

		switch (dbError.code) {
			case "23505": // Unique constraint violation
				return conflictResponse(c, uniqueViolationMessage(constraint));

			case "23503": // Foreign key constraint violation
				return errorResponse(c, "Referenced resource not found", 400, "INVALID_REFERENCE");

			case "23502": // Not null constraint violation
				return validationErrorResponse(c, "Required field is missing");

			case "23514": // Check constraint violation
				return validationErrorResponse(c, "Data validation failed");

			default:
				console.error("Database error:", error);
				return internalErrorResponse(c, "Database operation failed");
		}
	}

	if (error instanceof Error) {
		console.error("Database error:", error.message);
		return internalErrorResponse(c, "Database operation failed");
	}

	console.error("Unknown database error:", error);
	return internalErrorResponse(c, "Database operation failed");
}
