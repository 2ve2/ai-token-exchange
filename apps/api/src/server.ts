import { app } from "./app";
import { env } from "./config/env";

const server = Bun.serve({
	port: env.PORT,
	fetch: app.fetch,
});

console.log(`AI Token Exchange API listening on port ${server.port} (pid ${process.pid})`);
