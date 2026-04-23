export {};

declare global {
  interface Window {
    electronAPI?: {
      loadXml?: () => Promise<string>;
      openExternal?: (url: string) => Promise<void> | void;
      openAgentWindow?: (payload: { gemUrl: string; googleAccountId: string; keepVisible?: boolean }) => Promise<{
        ok: boolean;
        message: string;
        detectedAccountLabel?: string;
      }>;
      generateAgentSuggestion?: (payload: {
        gemUrl: string;
        googleAccountId: string;
        responseMode: 'fast' | 'reasoning' | 'pro';
        prompt: string;
        keepVisible?: boolean;
      }) => Promise<{
        ok: boolean;
        text: string;
        message: string;
        generatedAt: string;
      }>;
      getVersion?: () => Promise<string>;
      checkUpdate?: (updateUrl: string) => Promise<{
        ok: boolean;
        error?: string;
        currentVersion?: string;
        latestVersion?: string;
        isNewer?: boolean;
        notes?: string;
        downloadUrl?: string;
      }>;
      installUpdate?: (downloadUrl: string) => Promise<{
        ok: boolean;
        error?: string;
      }>;
    };
  }
}
