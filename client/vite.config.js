import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import { execSync } from "child_process";

let gitHash = "unknown";
try {
  gitHash = execSync("git rev-parse --short HEAD").toString().trim();
} catch (e) {}

const buildTime = new Date().toISOString();

export default defineConfig({
  plugins: [
    react(),
    legacy({
      targets: ['Chrome >= 51', 'Android >= 7'],
      additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
      renderLegacyChunks: true,
    }),
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(gitHash),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: {
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
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
