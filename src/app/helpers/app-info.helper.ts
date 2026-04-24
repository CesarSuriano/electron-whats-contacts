import versionData from '../../../version.json';

export const APP_VERSION: string = versionData.version;

export const APP_WHATS_NEW: string[] = versionData.notes
  .split('\n')
  .map((line: string) => line.replace(/^-\s*/, '').trim())
  .filter((line: string) => line.length > 0);
