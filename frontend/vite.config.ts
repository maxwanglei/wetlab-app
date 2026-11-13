import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: {
    outDir: "dist",
    // Plotly ships as one prebuilt ~4.6 MB file; it is lazy-loaded by the Results tab only.
    chunkSizeWarningLimit: 5000,
  },
});
