import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /socket.io на backend, щоб у dev режимі не возитися з CORS.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.VITE_BACKEND_URL || "http://localhost:4000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/socket.io": {
          target: backendUrl,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
