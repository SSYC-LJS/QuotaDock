<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type {
  BalancePayload,
  BalanceResult,
  CodexQuotaResult,
  CodexQuotaSnapshot,
  DeepSeekPlatformSessionResult,
  DeepSeekPlatformUsageResult,
  DeepSeekPlatformUsageTotal
} from '../electron/types';

type ViewMode = 'dashboard' | 'settings';
type ProviderMode = 'deepseek' | 'codex';

const apiKeyInput = ref('');
const balance = ref<BalancePayload | null>(null);
const platformUsage = ref<DeepSeekPlatformUsageTotal | null>(null);
const errorMessage = ref('');
const errorCode = ref('');
const fetchedAt = ref('');
const platformUsageFetchedAt = ref('');
const isLoading = ref(false);
const isSaving = ref(false);
const isPlatformLoading = ref(false);
const isExpanded = ref(false);
const isCompactHover = ref(false);
const hasApiKey = ref(false);
const storageAvailable = ref(true);
const platformLoggedIn = ref(false);
const viewMode = ref<ViewMode>('dashboard');
const providerMode = ref<ProviderMode>('deepseek');
const codexQuota = ref<CodexQuotaSnapshot | null>(null);
const isCodexLoading = ref(false);
const codexError = ref('');

let removeRefreshListener: (() => void) | null = null;
let removeLayoutListener: (() => void) | null = null;
let compactLeaveTimer: ReturnType<typeof setTimeout> | null = null;

const firstBalance = computed(() => balance.value?.balance_infos[0] ?? null);

const statusLabel = computed(() => {
  if (providerMode.value === 'codex') return codexError.value ? '快照异常' : '本地快照';
  if (!hasApiKey.value) return '未配置';
  if (isLoading.value || isPlatformLoading.value) return '同步中';
  if (balance.value?.is_available) return '可用';
  return '待刷新';
});

const statusTone = computed(() => {
  if (providerMode.value === 'codex') return codexError.value ? 'warning' : 'success';
  if (!hasApiKey.value || errorMessage.value) return 'warning';
  if (balance.value?.is_available) return 'success';
  return 'neutral';
});

const lastUpdatedLabel = computed(() => (fetchedAt.value ? formatDateTime(fetchedAt.value) : '尚未同步'));
const usageUpdatedLabel = computed(() =>
  platformUsageFetchedAt.value ? formatDateTime(platformUsageFetchedAt.value) : '尚未同步'
);

const codexLimits = computed(() => {
  const quota = codexQuota.value?.quota;
  return [
    {
      label: '5 小时',
      usedPercent: quota?.primary_used_percent,
      resetsAt: quota?.primary_resets_at
    },
    {
      label: '1 周',
      usedPercent: quota?.secondary_used_percent,
      resetsAt: quota?.secondary_resets_at
    }
  ].map((item) => {
    const used = typeof item.usedPercent === 'number' ? item.usedPercent : null;
    return {
      ...item,
      remainingPercent: used === null ? null : Math.max(0, Math.min(100, Math.round(100 - used)))
    };
  });
});

const nextCodexResetLabel = computed(() => {
  const resetTimes = codexLimits.value
    .map((item) => parseLocalResetTime(item.resetsAt))
    .filter((value): value is Date => !!value)
    .sort((left, right) => left.getTime() - right.getTime());
  return resetTimes.length ? formatShortResetTime(resetTimes[0]) : '未知';
});

const compactTitle = computed(() => (providerMode.value === 'codex' ? 'Codex 额度' : 'DeepSeek'));
const compactPrimary = computed(() => {
  if (providerMode.value === 'codex') {
    return codexLimits.value.map((item) => `${item.label} ${formatPercent(item.remainingPercent)}`).join(' / ');
  }
  return firstBalance.value ? formatMoney(firstBalance.value.total_balance, firstBalance.value.currency) : '余额待同步';
});
const compactSecondary = computed(() => {
  if (providerMode.value === 'codex') return `下次刷新 ${nextCodexResetLabel.value}`;
  return `累计消费 ${platformUsage.value ? formatMoney(platformUsage.value.amount, platformUsage.value.currency) : '待登录'}`;
});

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function formatMoney(value: string | number, currency = 'CNY'): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return `${currency} ${value}`;
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: amount > 0 && amount < 1 ? 4 : 2
  }).format(amount);
}

function formatPercent(value: number | null): string {
  return value === null ? '--' : `${value}%`;
}

function formatResetTime(value: string | null | undefined): string {
  const date = parseLocalResetTime(value);
  return date ? formatShortResetTime(date) : '--';
}

function formatShortResetTime(date: Date): string {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat('zh-CN', {
    month: sameDay ? undefined : 'numeric',
    day: sameDay ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function parseLocalResetTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.replace(/ ([+-]\d{2}):?(\d{2})$/, '$1:$2'));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function expandWidget(): Promise<void> {
  if (isExpanded.value) return;
  isExpanded.value = true;
  await window.deepseek.setWidgetLayout('expanded');
}

async function enterCompactHover(): Promise<void> {
  if (compactLeaveTimer) {
    clearTimeout(compactLeaveTimer);
    compactLeaveTimer = null;
  }
  if (isExpanded.value) return;
  isCompactHover.value = true;
  await window.deepseek.setWidgetLayout('compact-hover');
}

function leaveCompactHover(): void {
  if (compactLeaveTimer) clearTimeout(compactLeaveTimer);
  compactLeaveTimer = setTimeout(() => {
    if (isExpanded.value) return;
    isCompactHover.value = false;
    void window.deepseek.setWidgetLayout('compact');
  }, 220);
}

async function loadKeyStatus(): Promise<void> {
  const status = await window.deepseek.getKeyStatus();
  hasApiKey.value = status.hasApiKey;
  storageAvailable.value = status.storageAvailable;
  viewMode.value = status.hasApiKey ? 'dashboard' : 'settings';
}

function applyBalanceResult(result: BalanceResult): void {
  if (result.ok) {
    balance.value = result.data;
    fetchedAt.value = result.fetchedAt;
    if (!errorCode.value.startsWith('usage')) {
      errorMessage.value = '';
      errorCode.value = '';
    }
    return;
  }

  errorMessage.value = result.error;
  errorCode.value = result.code;
  if (result.code === 'missing-api-key') {
    hasApiKey.value = false;
    viewMode.value = 'settings';
  }
}

async function refreshBalance(): Promise<void> {
  if (!hasApiKey.value || isLoading.value) return;
  isLoading.value = true;
  try {
    applyBalanceResult(await window.deepseek.getBalance());
  } finally {
    isLoading.value = false;
  }
}

async function saveApiKey(): Promise<void> {
  if (!apiKeyInput.value.trim()) {
    errorMessage.value = '请输入 DeepSeek API Key。';
    errorCode.value = 'empty-input';
    return;
  }

  isSaving.value = true;
  try {
    const result = await window.deepseek.setApiKey(apiKeyInput.value);
    if (!result.ok) {
      errorMessage.value = result.error ?? '保存 API Key 失败。';
      errorCode.value = 'save-error';
      return;
    }

    apiKeyInput.value = '';
    hasApiKey.value = true;
    viewMode.value = 'dashboard';
    await refreshBalance();
  } finally {
    isSaving.value = false;
  }
}

function applyPlatformSessionResult(result: DeepSeekPlatformSessionResult): void {
  if (result.ok) {
    platformLoggedIn.value = result.data.loggedIn;
    return;
  }
  errorMessage.value = result.error;
  errorCode.value = 'usage-session-error';
}

function applyPlatformUsageResult(result: DeepSeekPlatformUsageResult): void {
  if (result.ok) {
    platformUsage.value = result.data;
    platformUsageFetchedAt.value = result.fetchedAt;
    platformLoggedIn.value = true;
    if (errorCode.value.startsWith('usage')) {
      errorMessage.value = '';
      errorCode.value = '';
    }
    return;
  }

  errorMessage.value = result.error;
  errorCode.value = `usage-${result.code}`;
  if (result.code === 'not-logged-in') {
    platformLoggedIn.value = false;
  }
}

async function refreshPlatformSessionStatus(): Promise<void> {
  applyPlatformSessionResult(await window.deepseek.getPlatformSessionStatus());
}

async function loginDeepSeekPlatform(): Promise<void> {
  applyPlatformSessionResult(await window.deepseek.loginPlatform());
  if (platformLoggedIn.value) await refreshPlatformUsage();
}

async function refreshPlatformUsage(): Promise<void> {
  if (isPlatformLoading.value) return;
  isPlatformLoading.value = true;
  try {
    applyPlatformUsageResult(await window.deepseek.getPlatformUsageTotal());
  } finally {
    isPlatformLoading.value = false;
  }
}

function switchProvider(mode: ProviderMode): void {
  providerMode.value = mode;
  if (mode === 'codex' && !codexQuota.value) void refreshCodexQuota();
}

function applyCodexQuotaResult(result: CodexQuotaResult): void {
  if (result.ok) {
    codexQuota.value = result.data;
    codexError.value = '';
    return;
  }
  codexError.value = result.error;
}

async function refreshCodexQuota(): Promise<void> {
  if (isCodexLoading.value) return;
  isCodexLoading.value = true;
  try {
    applyCodexQuotaResult(await window.deepseek.getCodexQuota());
  } finally {
    isCodexLoading.value = false;
  }
}

onMounted(async () => {
  await window.deepseek.setWidgetLayout('compact');
  await loadKeyStatus();
  await refreshPlatformSessionStatus();
  if (hasApiKey.value) await refreshBalance();
  if (platformLoggedIn.value) void refreshPlatformUsage();
  void refreshCodexQuota();

  removeRefreshListener = window.deepseek.onRefreshRequested(() => {
    void refreshBalance();
    if (platformLoggedIn.value) void refreshPlatformUsage();
  });
  removeLayoutListener = window.deepseek.onLayoutChanged((mode) => {
    isExpanded.value = mode === 'expanded';
    if (mode === 'compact') isCompactHover.value = false;
  });
});

onUnmounted(() => {
  if (compactLeaveTimer) clearTimeout(compactLeaveTimer);
  removeRefreshListener?.();
  removeLayoutListener?.();
});
</script>

<template>
  <main class="widget-shell" :class="{ compact: !isExpanded }">
    <section
      v-if="!isExpanded"
      class="compact-card"
      :class="{ hovering: isCompactHover }"
      @mouseenter="enterCompactHover"
      @mouseleave="leaveCompactHover"
    >
      <div class="compact-copy">
        <span>{{ compactTitle }}</span>
        <strong>{{ compactPrimary }}</strong>
        <em>{{ compactSecondary }}</em>
      </div>
      <button class="compact-expand-button" type="button" aria-label="展开 QuotaDock" @click="expandWidget">
        <span></span>
      </button>
      <div class="status-dot" :class="statusTone"></div>
    </section>

    <template v-else>
      <header class="titlebar">
        <div>
          <p class="eyeline">{{ providerMode === 'codex' ? 'Codex' : 'DeepSeek' }}</p>
          <h1>{{ providerMode === 'codex' ? '额度信息' : '后台消费' }}</h1>
        </div>
        <div class="status-chip" :class="statusTone">
          <span></span>
          {{ statusLabel }}
        </div>
      </header>

      <nav class="mode-switch" aria-label="服务模式">
        <button :class="{ active: providerMode === 'deepseek' }" @click="switchProvider('deepseek')">DeepSeek</button>
        <button :class="{ active: providerMode === 'codex' }" @click="switchProvider('codex')">Codex</button>
      </nav>

      <section v-if="providerMode === 'deepseek' && viewMode === 'settings'" class="settings-panel">
        <div class="section-heading">
          <h2>保存 API Key</h2>
          <p>API Key 只用于查询当前余额，密钥保存在本机安全存储中。</p>
        </div>
        <label class="input-group">
          <span>DeepSeek API Key</span>
          <input
            v-model="apiKeyInput"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="sk-..."
            @keydown.enter="saveApiKey"
          />
        </label>
        <p v-if="!storageAvailable" class="warning-text">当前系统未报告可用的安全加密存储，无法保存 API Key。</p>
        <button class="primary-button" :disabled="isSaving || !storageAvailable" @click="saveApiKey">
          {{ isSaving ? '保存中...' : '保存并同步' }}
        </button>
      </section>

      <section v-else-if="providerMode === 'deepseek'" class="deepseek-minimal">
        <article class="metric-card balance-card">
          <span>当前余额</span>
          <strong>{{ firstBalance ? formatMoney(firstBalance.total_balance, firstBalance.currency) : '--' }}</strong>
          <small>{{ lastUpdatedLabel }}</small>
        </article>

        <article class="metric-card spend-card">
          <span>累计消费</span>
          <strong>{{ platformUsage ? formatMoney(platformUsage.amount, platformUsage.currency) : '--' }}</strong>
          <small>{{ usageUpdatedLabel }}</small>
        </article>

        <button v-if="!platformLoggedIn" class="primary-button" @click="loginDeepSeekPlatform">登录 DeepSeek 后台</button>
        <p v-if="platformLoggedIn && !platformUsage" class="helper-text">
          已登录 DeepSeek 后台，正在尝试识别 Usage 后台接口。
        </p>
      </section>

      <section v-else class="codex-dashboard">
        <section class="quota-panel">
          <article v-for="item in codexLimits" :key="item.label" class="quota-card">
            <div class="quota-card-head">
              <strong>{{ item.label }}</strong>
              <span>{{ formatPercent(item.remainingPercent) }}</span>
            </div>
            <div class="quota-meter">
              <span :style="{ width: item.remainingPercent === null ? '0%' : `${item.remainingPercent}%` }"></span>
            </div>
            <div class="quota-meta">
              <span>下次刷新</span>
              <strong>{{ formatResetTime(item.resetsAt) }}</strong>
            </div>
          </article>
        </section>
        <p v-if="codexError" class="error-text" role="alert">
          <span>codex</span>
          {{ codexError }}
        </p>
      </section>

      <footer>
        <p v-if="errorMessage" class="error-text" role="alert">
          <span>{{ errorCode }}</span>
          {{ errorMessage }}
        </p>
      </footer>
    </template>
  </main>
</template>
