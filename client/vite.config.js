import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import circleDependency from "vite-plugin-circular-dependency";

export default defineConfig({
  plugins: [
    react(),
    circleDependency({
      circleImportThrowErr: false,
      outputFilePath: './circulars.txt'
    })
  ],
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
    },
  },
});
