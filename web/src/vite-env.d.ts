/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_PORT?: string;
  /** Set to "1" to skip the Vite proxy and open ws://host:VITE_API_PORT/ws (dev only). */
  readonly VITE_WS_DIRECT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
