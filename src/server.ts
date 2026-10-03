import index from "./web/index.html";
import { apiRoutes } from "./api";
import { createStore } from "./db";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_AUTH_TOKEN;

if (!accountId || !apiToken) {
  console.warn("⚠  CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env to run inference.");
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,
    ...apiRoutes({ store: createStore(process.env.CLEF_DB ?? "data/sqlite/clef.sqlite"), accountId, apiToken }),
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`Clef playground → ${server.url}`);
