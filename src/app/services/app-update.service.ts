import { Injectable } from '@angular/core';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'error';

export interface CheckUpdateResult {
  ok: boolean;
  error?: string;
  currentVersion?: string;
  latestVersion?: string;
  isNewer?: boolean;
  notes?: string;
  downloadUrl?: string;
}

const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/CesarSuriano/electron-whats-contacts/refs/heads/master/version.json';

@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  async checkForUpdate(): Promise<CheckUpdateResult> {
    if (!window.electronAPI?.checkUpdate) {
      return { ok: false, error: 'Disponível apenas no app instalado.' };
    }
    return window.electronAPI.checkUpdate(UPDATE_MANIFEST_URL);
  }

  async installUpdate(downloadUrl: string): Promise<{ ok: boolean; error?: string }> {
    if (!window.electronAPI?.installUpdate) {
      return { ok: false, error: 'Disponível apenas no app instalado.' };
    }
    return window.electronAPI.installUpdate(downloadUrl);
  }
}
