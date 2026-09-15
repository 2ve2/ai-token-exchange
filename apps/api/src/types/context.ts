import type { User } from "@/db/schema";

export interface AppEnv {
	Variables: {
		user: User;
	};
}
