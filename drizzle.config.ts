import { defineConfig } from "drizzle-kit";
// drizzle-kit 跑在 Next 之外，不会自动读 .env.local；用 Node 内置 loadEnvFile 注入连接串
process.loadEnvFile(".env.local");
export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
