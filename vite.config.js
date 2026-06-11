import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import https from "node:https";

const WORKER_TARGET = "https://finddeals.trovescore.com";
// Force IPv4: DNS returns both IPv4 and IPv6 for this host, but IPv6 is
// unreachable locally, causing Node.js happy-eyeballs to produce ETIMEDOUT.
const ipv4Agent = new https.Agent({ family: 4 });

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
      "/nyt":   { target: WORKER_TARGET, changeOrigin: true, agent: ipv4Agent, ...logProxy("nyt") },
      "/ebay":  { target: WORKER_TARGET, changeOrigin: true, agent: ipv4Agent, ...logProxy("ebay") },
      "/debug": { target: WORKER_TARGET, changeOrigin: true, agent: ipv4Agent, ...logProxy("debug") },
    },
  },
});
