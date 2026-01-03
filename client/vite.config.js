import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
    minify: false
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/getToken": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/signaling": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
      "/socket.io": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
