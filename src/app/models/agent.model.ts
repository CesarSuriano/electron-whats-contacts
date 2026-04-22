export type AgentSuggestionStatus = 'idle' | 'thinking' | 'ready' | 'error';

export type AgentResponseMode = 'fast' | 'reasoning' | 'pro';

export interface AgentGoogleAccountProfile {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AgentSettings {
  enabled: boolean;
  gemUrl: string;
  responseMode: AgentResponseMode;
  googleAccounts: AgentGoogleAccountProfile[];
  activeGoogleAccountId: string;
}

export interface AgentSuggestionSnapshot {
  status: AgentSuggestionStatus;
  contactJid: string;
  contextKey: string;
  suggestion: string;
  errorMessage: string;
  source: 'gem' | 'none';
  updatedAt: string | null;
}

export interface AgentWindowActionResult {
  ok: boolean;
  message: string;
  detectedAccountLabel?: string;
}

export function createAgentGoogleAccountProfile(label = 'Conta Google principal', id = 'primary'): AgentGoogleAccountProfile {
  return {
    id,
    label,
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  gemUrl: '',
  responseMode: 'fast',
  googleAccounts: [createAgentGoogleAccountProfile()],
  activeGoogleAccountId: 'primary'
};

export const IDLE_AGENT_SUGGESTION: AgentSuggestionSnapshot = {
  status: 'idle',
  contactJid: '',
  contextKey: '',
  suggestion: '',
  errorMessage: '',
  source: 'none',
  updatedAt: null
};