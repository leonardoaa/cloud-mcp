import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../dist-web"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:37242" },
  },
});
