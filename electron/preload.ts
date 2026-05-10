import { contextBridge, ipcRenderer } from 'electron';
import type {
  BalanceResult,
  ClearApiKeyResult,
  CodexQuotaResult,
  DeepSeekPlatformSessionResult,
  DeepSeekPlatformUsageResult,
  SetApiKeyResult,
  StoredKeyStatus,
  WidgetLayoutMode
} from './types';

contextBridge.exposeInMainWorld('deepseek', {
  getBalance: (): Promise<BalanceResult> => ipcRenderer.invoke('deepseek:getBalance'),
  getKeyStatus: (): Promise<StoredKeyStatus> => ipcRenderer.invoke('deepseek:getKeyStatus'),
  setApiKey: (apiKey: string): Promise<SetApiKeyResult> => ipcRenderer.invoke('deepseek:setApiKey', apiKey),
  clearApiKey: (): Promise<ClearApiKeyResult> => ipcRenderer.invoke('deepseek:clearApiKey'),
  openUsagePage: (): Promise<void> => ipcRenderer.invoke('deepseek:openUsagePage'),
  loginPlatform: (): Promise<DeepSeekPlatformSessionResult> => ipcRenderer.invoke('deepseek:loginPlatform'),
  getPlatformSessionStatus: (): Promise<DeepSeekPlatformSessionResult> =>
    ipcRenderer.invoke('deepseek:getPlatformSessionStatus'),
  getPlatformUsageTotal: (): Promise<DeepSeekPlatformUsageResult> =>
    ipcRenderer.invoke('deepseek:getPlatformUsageTotal'),
  getCodexQuota: (): Promise<CodexQuotaResult> => ipcRenderer.invoke('codex:getQuota'),
  setWidgetLayout: (mode: WidgetLayoutMode): Promise<void> => ipcRenderer.invoke('window:setLayout', mode),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('window:hide'),
  onLayoutChanged: (callback: (mode: WidgetLayoutMode) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: WidgetLayoutMode): void => callback(mode);
    ipcRenderer.on('window:layoutChanged', listener);
    return () => ipcRenderer.removeListener('window:layoutChanged', listener);
  },
  onRefreshRequested: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on('deepseek:refreshRequested', listener);
    return () => ipcRenderer.removeListener('deepseek:refreshRequested', listener);
  }
});
