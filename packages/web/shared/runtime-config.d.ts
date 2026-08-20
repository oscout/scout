export declare const DEFAULT_API_BASE_PATH: string;
export declare const DEFAULT_BOOTSTRAP_SCRIPT_PATH: string;
export declare const DEFAULT_HEALTH_PATH: string;
export declare const DEFAULT_TERMINAL_RUN_PATH: string;
export declare const DEFAULT_UPLOAD_PATH: string;
export declare const DEFAULT_RELAY_UPLOAD_PATH: string;
export declare const DEFAULT_TERMINAL_RELAY_PATH: string;
export declare const DEFAULT_TERMINAL_RELAY_HEALTH_PATH: string;
export declare const DEFAULT_TAIL_STREAM_PATH: string;
export declare const DEFAULT_EVENTS_STREAM_PATH: string;
export declare const DEFAULT_VITE_HMR_PATH: string;

export type OpenScoutWebRoutes = {
  apiBasePath: string;
  bootstrapScriptPath: string;
  healthPath: string;
  terminalRunPath: string;
  uploadPath: string;
  relayUploadPath: string;
  terminalRelayPath: string;
  terminalRelayHealthPath: string;
  tailStreamPath: string;
  eventsStreamPath: string;
  viteHmrPath: string;
};

export type OpenScoutWebFeatureFlags = {
  bundle?: string;
};

export type OpenScoutWebBootstrap = {
  featureFlags: OpenScoutWebFeatureFlags;
  routes: OpenScoutWebRoutes;
};

export declare function normalizeRoutePath(value: unknown, fallback: string): string;
export declare function resolveOpenScoutWebRoutes(
  env?: Record<string, string | undefined>,
): OpenScoutWebRoutes;
export declare function normalizeOpenScoutWebFlagBundle(value: unknown): string | null;
export declare function resolveOpenScoutWebFeatureFlags(
  env?: Record<string, string | undefined>,
): OpenScoutWebFeatureFlags;
export declare function createOpenScoutWebBootstrap(
  env?: Record<string, string | undefined>,
): OpenScoutWebBootstrap;
export declare function serializeOpenScoutWebBootstrap(
  env?: Record<string, string | undefined>,
): string;
