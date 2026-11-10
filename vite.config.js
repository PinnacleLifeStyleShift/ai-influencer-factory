import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { serveConfig } from "./src/securityHeaders.js";

// Writes dist/serve.json (security headers) for the production static server.
const securityHeadersPlugin = () => ({
  name: "aif-security-headers",
  apply: "build",
  closeBundle() {
    const out = path.resolve("dist/serve.json");
    fs.writeFileSync(out, JSON.stringify(serveConfig(process.env.VITE_API_URL || ""), null, 2));
  },
});

export default defineConfig({
  plugins: [react(), securityHeadersPlugin()],
  server: {
    host: "0.0.0.0",
    port: parseInt(process.env.PORT) || 5173,
  },
  preview: {
    host: "0.0.0.0",
    port: parseInt(process.env.PORT) || 4173,
  },
});
