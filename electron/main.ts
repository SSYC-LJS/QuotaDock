import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell
} from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  BalancePayload,
  BalanceResult,
  ClearApiKeyResult,
  CodexQuotaResult,
  CodexQuotaSnapshot,
  DeepSeekPlatformSessionResult,
  DeepSeekPlatformUsageResult,
  SetApiKeyResult,
  StoredKeyStatus,
  WidgetLayoutMode
} from './types';

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const DEEPSEEK_PLATFORM_URL = 'https://platform.deepseek.com';
const DEEPSEEK_USAGE_URL = `${DEEPSEEK_PLATFORM_URL}/usage`;
const DEEPSEEK_SESSION_PARTITION = 'persist:deepseek-platform';
const REFRESH_INTERVAL_MS = 60 * 1000;
const COMPACT_BOUNDS = { width: 198, height: 58 };
const COMPACT_HOVER_BOUNDS = { width: 336, height: 112 };
const EXPANDED_BOUNDS = { width: 390, height: 430 };
const EDGE_GAP = 10;
const execFileAsync = promisify(execFile);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let inFlightBalanceRequest: Promise<BalanceResult> | null = null;
let currentLayout: WidgetLayoutMode = 'compact';
let isQuitting = false;

const keyFilePath = (): string => join(app.getPath('userData'), 'secure', 'deepseek-api-key.bin');
const codexStatusScriptPath = (): string =>
  join(app.getPath('home'), '.codex', 'skills', 'codex-team-space-switcher', 'scripts', 'show-status.ps1');

function createTrayIcon(): Electron.NativeImage {
  const svg = `
    <svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <rect width="64" height="64" rx="16" fill="#0F172A"/>
      <path d="M18 34C18 24.611 25.611 17 35 17H46V28H35C31.686 28 29 30.686 29 34C29 37.314 31.686 40 35 40H46V51H35C25.611 51 18 43.389 18 34Z" fill="#38BDF8"/>
      <path d="M36 28H48C51.314 28 54 30.686 54 34C54 37.314 51.314 40 48 40H36V28Z" fill="#14B8A6"/>
      <circle cx="17" cy="17" r="6" fill="#F8FAFC"/>
    </svg>`;

  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: COMPACT_BOUNDS.width,
    height: COMPACT_BOUNDS.height,
    minWidth: COMPACT_BOUNDS.width,
    minHeight: COMPACT_BOUNDS.height,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#eef3f8',
    title: 'QuotaDock',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    setWidgetLayout('compact');
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('blur', () => {
    if (currentLayout === 'expanded') {
      setWidgetLayout('compact');
      mainWindow?.webContents.send('window:layoutChanged', 'compact');
    }
  });

  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function sendRefreshRequest(): void {
  mainWindow?.webContents.send('deepseek:refreshRequested');
}

function updateTrayMenu(): void {
  if (!tray) return;

  const isVisible = mainWindow?.isVisible() ?? false;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isVisible ? '隐藏 QuotaDock' : '显示 QuotaDock',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
        updateTrayMenu();
      }
    },
    {
      label: '刷新余额',
      click: sendRefreshRequest
    },
    {
      label: '打开 DeepSeek 用量页',
      click: () => {
        void shell.openExternal(DEEPSEEK_USAGE_URL);
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('QuotaDock');
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    updateTrayMenu();
  });
  updateTrayMenu();
}

function boundsForLayout(mode: WidgetLayoutMode): { width: number; height: number } {
  if (mode === 'expanded') return EXPANDED_BOUNDS;
  if (mode === 'compact-hover') return COMPACT_HOVER_BOUNDS;
  return COMPACT_BOUNDS;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function setWidgetLayout(mode: WidgetLayoutMode): void {
  if (!mainWindow) return;
  if (currentLayout === mode) return;

  const previousBounds = mainWindow.getBounds();
  currentLayout = mode;
  const nextBounds = boundsForLayout(mode);
  mainWindow.setResizable(mode === 'expanded');
  mainWindow.setMinimumSize(nextBounds.width, nextBounds.height);
  mainWindow.setSize(nextBounds.width, nextBounds.height, false);

  if (mode === 'expanded') {
    placeExpandedWindow(previousBounds);
    return;
  }

  snapWindowToNearestHorizontalEdge();
}

function placeExpandedWindow(previousBounds: Electron.Rectangle): void {
  if (!mainWindow) return;

  const display = screen.getDisplayMatching(previousBounds);
  const area = display.workArea;
  const previousCenterX = previousBounds.x + previousBounds.width / 2;
  const areaCenterX = area.x + area.width / 2;
  const shouldOpenRight = previousCenterX < areaCenterX;
  const x = shouldOpenRight ? area.x + EDGE_GAP : area.x + area.width - EXPANDED_BOUNDS.width - EDGE_GAP;
  const y = clamp(
    previousBounds.y,
    area.y + EDGE_GAP,
    area.y + area.height - EXPANDED_BOUNDS.height - EDGE_GAP
  );

  mainWindow.setPosition(Math.round(x), Math.round(y), true);
}

function snapWindowToNearestHorizontalEdge(): void {
  if (!mainWindow) return;

  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const centerX = bounds.x + bounds.width / 2;
  const areaCenterX = area.x + area.width / 2;
  const x = centerX < areaCenterX ? area.x + EDGE_GAP : area.x + area.width - bounds.width - EDGE_GAP;
  const y = clamp(bounds.y, area.y + EDGE_GAP, area.y + area.height - bounds.height - EDGE_GAP);
  mainWindow.setPosition(Math.round(x), Math.round(y), true);
}

function getKeyStatus(): StoredKeyStatus {
  return {
    hasApiKey: existsSync(keyFilePath()),
    storageAvailable: safeStorage.isEncryptionAvailable()
  };
}

function readApiKey(): string | null {
  const filePath = keyFilePath();
  if (!existsSync(filePath)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统环境不支持 Electron safeStorage 加密。');
  }

  const encryptedKey = readFileSync(filePath);
  return safeStorage.decryptString(encryptedKey);
}

function writeApiKey(apiKey: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统环境不支持 Electron safeStorage 加密。');
  }

  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    throw new Error('API Key 不能为空。');
  }

  const filePath = keyFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, safeStorage.encryptString(normalizedKey), { mode: 0o600 });
}

function clearApiKey(): void {
  const filePath = keyFilePath();
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

function isBalancePayload(value: unknown): value is BalancePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as BalancePayload;
  return (
    typeof candidate.is_available === 'boolean' &&
    Array.isArray(candidate.balance_infos) &&
    candidate.balance_infos.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.currency === 'string' &&
        typeof item.total_balance === 'string' &&
        typeof item.granted_balance === 'string' &&
        typeof item.topped_up_balance === 'string'
    )
  );
}

async function fetchBalance(): Promise<BalanceResult> {
  if (inFlightBalanceRequest) return inFlightBalanceRequest;

  inFlightBalanceRequest = (async () => {
    let apiKey: string | null;

    try {
      apiKey = readApiKey();
    } catch (error) {
      return {
        ok: false,
        code: 'storage-error',
        error: error instanceof Error ? error.message : '读取本机安全存储失败。'
      };
    }

    if (!apiKey) {
      return {
        ok: false,
        code: 'missing-api-key',
        error: '请先保存 DeepSeek API Key。'
      };
    }

    try {
      const response = await fetch(DEEPSEEK_BALANCE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        return {
          ok: false,
          code: 'http-error',
          status: response.status,
          error: `DeepSeek 返回 HTTP ${response.status}。`
        };
      }

      const payload: unknown = await response.json();
      if (!isBalancePayload(payload)) {
        return {
          ok: false,
          code: 'invalid-response',
          error: 'DeepSeek 返回的数据格式与预期不一致。'
        };
      }

      return {
        ok: true,
        data: payload,
        fetchedAt: new Date().toISOString()
      };
    } catch {
      return {
        ok: false,
        code: 'network-error',
        error: '无法连接 DeepSeek API，请检查网络或代理设置。'
      };
    }
  })();

  try {
    return await inFlightBalanceRequest;
  } finally {
    inFlightBalanceRequest = null;
  }
}

function getDeepSeekSession(): Electron.Session {
  return session.fromPartition(DEEPSEEK_SESSION_PARTITION);
}

async function hasDeepSeekPlatformSession(): Promise<boolean> {
  const cookies = await getDeepSeekSession().cookies.get({ domain: 'platform.deepseek.com' });
  return cookies.some((cookie) => !cookie.expirationDate || cookie.expirationDate * 1000 > Date.now());
}

async function getPlatformSessionStatus(): Promise<DeepSeekPlatformSessionResult> {
  try {
    return { ok: true, data: { loggedIn: await hasDeepSeekPlatformSession() } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '读取 DeepSeek 登录状态失败。' };
  }
}

async function loginDeepSeekPlatform(): Promise<DeepSeekPlatformSessionResult> {
  return new Promise((resolve) => {
    const loginWindow = new BrowserWindow({
      width: 1100,
      height: 820,
      title: '登录 DeepSeek 平台',
      webPreferences: {
        partition: DEEPSEEK_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    let settled = false;
    const finish = async (): Promise<void> => {
      if (settled) return;
      if (!(await hasDeepSeekPlatformSession())) return;
      settled = true;
      resolve({ ok: true, data: { loggedIn: true } });
      loginWindow.close();
    };

    loginWindow.webContents.on('did-navigate', () => void finish());
    loginWindow.webContents.on('did-navigate-in-page', () => void finish());
    loginWindow.webContents.on('did-finish-load', () => void finish());
    loginWindow.on('closed', async () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, data: { loggedIn: await hasDeepSeekPlatformSession() } });
    });

    void loginWindow.loadURL(DEEPSEEK_PLATFORM_URL);
  });
}

async function fetchDeepSeekPlatformUsageTotal(): Promise<DeepSeekPlatformUsageResult> {
  if (!(await hasDeepSeekPlatformSession())) {
    return {
      ok: false,
      code: 'not-logged-in',
      error: '请先登录 DeepSeek 后台。'
    };
  }

  try {
    const usageWindow = new BrowserWindow({
      width: 1100,
      height: 820,
      show: false,
      webPreferences: {
        partition: DEEPSEEK_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    try {
      await usageWindow.loadURL(DEEPSEEK_USAGE_URL);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const result = (await usageWindow.webContents.executeJavaScript(usageDiscoveryScript(), true)) as {
        amount: number;
        currency: string;
        monthsScanned: number;
        source: string;
      } | null;

      if (!result || !Number.isFinite(result.amount)) {
        return {
          ok: false,
          code: 'usage-endpoint-unavailable',
          error: '未能从 DeepSeek 后台识别消费接口，请重新登录或检查 Usage 页面是否改版。'
        };
      }

      return {
        ok: true,
        data: result,
        fetchedAt: new Date().toISOString()
      };
    } finally {
      usageWindow.destroy();
    }
  } catch {
    return {
      ok: false,
      code: 'network-error',
      error: '读取 DeepSeek 后台消费失败。'
    };
  }
}

function usageDiscoveryScript(): string {
  return `
    (async () => {
      const moneyKeys = ['amount', 'cost', 'fee', 'spent', 'expense', 'consume', 'consumption', 'total_amount', 'total_cost', 'total_fee'];
      const resourceUrls = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => {
          const lower = String(url).toLowerCase();
          return lower.includes('platform.deepseek.com') &&
            lower.includes('/api/') &&
            /(usage|bill|cost|spend|consume|amount|wallet|balance)/.test(lower);
        });

      const candidateUrls = [...new Set(resourceUrls)];
      const monthValues = [];
      const now = new Date();
      for (let i = 0; i < 36; i += 1) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        monthValues.push(String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0'));
      }

      function numeric(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
          const parsed = Number(value.replace(/[¥￥,$\\s]/g, ''));
          if (Number.isFinite(parsed)) return parsed;
        }
        return null;
      }

      function collectAmounts(value) {
        const amounts = [];
        if (Array.isArray(value)) {
          for (const item of value) amounts.push(...collectAmounts(item));
          return amounts;
        }
        if (!value || typeof value !== 'object') return amounts;

        for (const [key, child] of Object.entries(value)) {
          const normalized = key.toLowerCase().replace(/[\\s_\\-]/g, '');
          if (moneyKeys.some((candidate) => normalized.includes(candidate.replace(/[\\s_\\-]/g, '')))) {
            const amount = numeric(child);
            if (amount !== null && amount >= 0 && amount < 100000000) amounts.push(amount);
          }
          amounts.push(...collectAmounts(child));
        }
        return amounts;
      }

      async function tryFetch(url) {
        const response = await fetch(url, { credentials: 'include' });
        const text = await response.text();
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !contentType.includes('json')) return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }

      const totals = [];
      for (const originalUrl of candidateUrls) {
        const variants = [originalUrl];
        try {
          const url = new URL(originalUrl);
          if ([...url.searchParams.keys()].some((key) => /month|date|time|period/i.test(key))) {
            for (const month of monthValues) {
              const clone = new URL(originalUrl);
              for (const key of [...clone.searchParams.keys()]) {
                if (/month|date|time|period/i.test(key)) clone.searchParams.set(key, month);
              }
              variants.push(clone.toString());
            }
          }
        } catch {}

        let emptyMonths = 0;
        for (const url of [...new Set(variants)]) {
          try {
            const json = await tryFetch(url);
            if (!json) continue;
            const amounts = collectAmounts(json);
            if (!amounts.length) {
              emptyMonths += 1;
              if (emptyMonths >= 6) break;
              continue;
            }
            totals.push({
              source: originalUrl,
              amount: Math.max(...amounts),
              monthly: url !== originalUrl
            });
          } catch {}
        }
      }

      if (totals.length) {
        const monthly = totals.filter((item) => item.monthly);
        if (monthly.length) {
          const source = monthly[0].source;
          const amount = monthly.filter((item) => item.source === source).reduce((sum, item) => sum + item.amount, 0);
          return { amount, currency: 'CNY', monthsScanned: monthly.filter((item) => item.source === source).length, source };
        }

        const best = totals.sort((left, right) => right.amount - left.amount)[0];
        return { amount: best.amount, currency: 'CNY', monthsScanned: 1, source: best.source };
      }

      const text = document.body?.innerText || '';
      const matches = [...text.matchAll(/[¥￥]\\s*([0-9]+(?:\\.[0-9]+)?)/g)].map((match) => Number(match[1]));
      const amount = matches.filter(Number.isFinite).sort((a, b) => b - a)[0];
      return Number.isFinite(amount) ? { amount, currency: 'CNY', monthsScanned: 1, source: 'usage-page-dom' } : null;
    })();
  `;
}

function registerIpcHandlers(): void {
  ipcMain.handle('deepseek:getKeyStatus', () => getKeyStatus());
  ipcMain.handle('deepseek:getBalance', () => fetchBalance());
  ipcMain.handle('deepseek:setApiKey', (_event, apiKey: string): SetApiKeyResult => {
    try {
      writeApiKey(apiKey);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '保存 API Key 失败。'
      };
    }
  });
  ipcMain.handle('deepseek:clearApiKey', (): ClearApiKeyResult => {
    try {
      clearApiKey();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '清除 API Key 失败。'
      };
    }
  });
  ipcMain.handle('deepseek:openUsagePage', () => shell.openExternal(DEEPSEEK_USAGE_URL));
  ipcMain.handle('deepseek:loginPlatform', () => loginDeepSeekPlatform());
  ipcMain.handle('deepseek:getPlatformSessionStatus', () => getPlatformSessionStatus());
  ipcMain.handle('deepseek:getPlatformUsageTotal', () => fetchDeepSeekPlatformUsageTotal());
  ipcMain.handle('codex:getQuota', () => fetchCodexQuota());
  ipcMain.handle('window:setLayout', (_event, mode: WidgetLayoutMode) => {
    setWidgetLayout(mode);
  });
}

function isCodexQuotaSnapshot(value: unknown): value is CodexQuotaSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as CodexQuotaSnapshot;
  return 'auth_mode' in candidate && 'quota' in candidate;
}

async function fetchCodexQuota(): Promise<CodexQuotaResult> {
  const scriptPath = codexStatusScriptPath();
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      code: 'script-not-found',
      error: '未找到 Codex 本地额度状态脚本。'
    };
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024
      }
    );
    const parsed: unknown = JSON.parse(stdout);

    if (!isCodexQuotaSnapshot(parsed)) {
      return {
        ok: false,
        code: 'invalid-response',
        error: 'Codex 额度脚本返回格式与预期不一致。'
      };
    }

    return {
      ok: true,
      data: parsed,
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      code: 'script-error',
      error: error instanceof Error ? error.message : '读取 Codex 额度失败。'
    };
  }
}

function startAutoRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(sendRefreshRequest, REFRESH_INTERVAL_MS);
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  createTray();
  startAutoRefresh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
