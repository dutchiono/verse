import { defineConfig, loadEnv, createLogger } from "vite";
import react from "@vitejs/plugin-react";

const baseLogger = createLogger();
/** Vite logs transient proxy errors while the API starts/restarts — noise in normal dev. */
const devLogger = {
  ...baseLogger,
  error(msg: string, options?: Parameters<typeof baseLogger.error>[1]) {
    const text = String(msg ?? "");
    const err = options?.error as NodeJS.ErrnoException | undefined;
    const code = err?.code;
    if (
      code === "ECONNABORTED" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      ((text.includes("proxy error") || text.includes("ws proxy socket error")) &&
        (text.includes("ECONNABORTED") || text.includes("ECONNRESET") || text.includes("ECONNREFUSED")))
    ) {
      return;
    }
    baseLogger.error(msg, options);
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.VITE_API_PORT ?? "7000";
  const webPort = Number(env.VITE_PORT ?? "7003");
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const wsOrigin = `ws://127.0.0.1:${apiPort}`;

  return {
    customLogger: devLogger,
    plugins: [react()],
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": { target: apiOrigin, changeOrigin: true },
        "/ws": { target: wsOrigin, ws: true },
      },
    },
  };
});
