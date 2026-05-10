/// <reference types="vite/client" />

import type {
  BalanceResult,
  ClearApiKeyResult,
  CodexQuotaResult,
  DeepSeekPlatformSessionResult,
  DeepSeekPlatformUsageResult,
  SetApiKeyResult,
  StoredKeyStatus,
  WidgetLayoutMode
} from '../electron/types';

declare global {
  interface Window {
    deepseek: {
      getBalance: () => Promise<BalanceResult>;
      getKeyStatus: () => Promise<StoredKeyStatus>;
      setApiKey: (apiKey: string) => Promise<SetApiKeyResult>;
      clearApiKey: () => Promise<ClearApiKeyResult>;
      openUsagePage: () => Promise<void>;
      loginPlatform: () => Promise<DeepSeekPlatformSessionResult>;
      getPlatformSessionStatus: () => Promise<DeepSeekPlatformSessionResult>;
      getPlatformUsageTotal: () => Promise<DeepSeekPlatformUsageResult>;
      getCodexQuota: () => Promise<CodexQuotaResult>;
      setWidgetLayout: (mode: WidgetLayoutMode) => Promise<void>;
      hideWindow: () => Promise<void>;
      onLayoutChanged: (callback: (mode: WidgetLayoutMode) => void) => () => void;
      onRefreshRequested: (callback: () => void) => () => void;
    };
  }
}
