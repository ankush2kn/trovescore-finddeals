import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const WORKER_TARGET = "https://finddeals.trovescore.com";

function logProxy(name) {
  return {
    configure(proxy) {
      proxy.on("proxyReq", (_, req) =>
        console.log(`[worker] → ${name}${req.url?.replace(`/${name}`, "") ?? ""}`)
      );
      proxy.on("proxyRes", (res, req) =>
        console.log(`[worker] ← ${name} ${res.statusCode}`)
      );
      proxy.on("error", (err) =>
        console.error(`[worker] ✗ ${name}`, err.message)
      );
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/nyt":   { target: WORKER_TARGET, changeOrigin: true, ...logProxy("nyt") },
      "/ebay":  { target: WORKER_TARGET, changeOrigin: true, ...logProxy("ebay") },
      "/debug": { target: WORKER_TARGET, changeOrigin: true, ...logProxy("debug") },
    },
  },
});
