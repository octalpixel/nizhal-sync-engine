// Shared (platform-agnostic) transport options. The concrete transport is picked by Metro per
// platform: echo.native.ts (nitro fetch/websockets) vs echo.ts (browser fetch/WebSocket).
export interface EchoOptions {
  server: string;
  token?: string;
  realtimeHost?: string;
  refreshToken?: () => Promise<string>;
  bucketsForSyncRule: (rule: string) => string[];
}

export function buildAuth(opts: EchoOptions) {
  if (!opts.token) return undefined;
  return {
    headers: { authorization: `Bearer ${opts.token}` },
    // auth.refresh replaces an expired bearer on a 401 so the mutation retries instead of dead-lettering.
    refresh: opts.refreshToken
      ? async () => ({ authorization: `Bearer ${await opts.refreshToken?.()}` })
      : undefined,
  };
}
