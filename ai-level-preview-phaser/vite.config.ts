import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: {
      host: "xiaoniudeMac-mini.local",
      clientPort: 5173
    }
  }
});
