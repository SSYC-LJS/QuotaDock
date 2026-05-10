export interface BalanceInfo {
  currency: 'CNY' | 'USD' | string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface BalancePayload {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

export type BalanceResult =
  | {
      ok: true;
      data: BalancePayload;
      fetchedAt: string;
    }
  | {
      ok: false;
      error: string;
      code: 'missing-api-key' | 'http-error' | 'network-error' | 'invalid-response' | 'storage-error';
      status?: number;
    };

export interface StoredKeyStatus {
  hasApiKey: boolean;
  storageAvailable: boolean;
}

export interface SetApiKeyResult {
  ok: boolean;
  error?: string;
}

export interface ClearApiKeyResult {
  ok: boolean;
  error?: string;
}

export interface DeepSeekPlatformSessionStatus {
  loggedIn: boolean;
}

export interface DeepSeekPlatformUsageTotal {
  amount: number;
  currency: string;
  monthsScanned: number;
  source: string;
}

export type DeepSeekPlatformSessionResult =
  | {
      ok: true;
      data: DeepSeekPlatformSessionStatus;
    }
  | {
      ok: false;
      error: string;
    };

export type DeepSeekPlatformUsageResult =
  | {
      ok: true;
      data: DeepSeekPlatformUsageTotal;
      fetchedAt: string;
    }
  | {
      ok: false;
      error: string;
      code: 'not-logged-in' | 'usage-endpoint-unavailable' | 'network-error';
    };

export interface CodexQuotaSnapshot {
  auth_mode: string | null;
  email: string | null;
  plan: string | null;
  quota: {
    timestamp: string | null;
    primary_used_percent: number | null;
    primary_window_minutes: number | null;
    primary_resets_at: string | null;
    secondary_used_percent: number | null;
    secondary_window_minutes: number | null;
    secondary_resets_at: string | null;
    total_tokens: number | null;
  } | null;
}

export type CodexQuotaResult =
  | {
      ok: true;
      data: CodexQuotaSnapshot;
      fetchedAt: string;
    }
  | {
      ok: false;
      error: string;
      code: 'script-not-found' | 'script-error' | 'invalid-response';
    };

export type WidgetLayoutMode = 'compact' | 'compact-hover' | 'expanded';
