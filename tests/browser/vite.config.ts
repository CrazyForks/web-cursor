import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@": workspaceRoot,
    },
  },
  optimizeDeps: {
    include: ["@isomorphic-git/lightning-fs", "buffer", "isomorphic-git"],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    fs: { allow: [workspaceRoot] },
  },
});
