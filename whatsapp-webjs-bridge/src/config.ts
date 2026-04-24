export interface BridgeConfig {
  allowedOrigins: string[];
  instanceName: string;
  port: number;
  enableHistoryEvents: boolean;
  enableProfilePhotoFetch: boolean;
  puppeteerExecutablePath: string | undefined;
  puppeteerArgs: string[];
  maxUploadBytes: number;
  dataPath: string | undefined;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const allowedOriginRaw = env.ALLOWED_ORIGIN || 'http://localhost:4200';
  const allowedOrigins = allowedOriginRaw
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  const puppeteerArgsRaw = env.PUPPETEER_ARGS || '--no-sandbox,--disable-setuid-sandbox';
  const puppeteerArgs = puppeteerArgsRaw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  return {
    allowedOrigins,
    instanceName: env.INSTANCE_NAME || 'local-webjs',
    port: Number(env.PORT || 3344),
    enableHistoryEvents: String(env.WA_ENABLE_HISTORY_EVENTS || 'true').toLowerCase() !== 'false',
    enableProfilePhotoFetch: String(env.WA_ENABLE_PROFILE_PHOTO_FETCH || 'true').toLowerCase() !== 'false',
    puppeteerExecutablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
    puppeteerArgs,
    maxUploadBytes: 50 * 1024 * 1024,
    dataPath: env.WWEBJS_DATA_PATH || undefined
  };
}
