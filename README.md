# QuotaDock

模型额度与用量看板。QuotaDock 是一个 Windows 优先的 Electron + Vue 桌面小组件，用来查看不同模型平台的余额、额度、用量和刷新时间。

## 当前能力

- DeepSeek
  - 查询 API 余额：`GET https://api.deepseek.com/user/balance`
  - 通过内置 DeepSeek 平台登录态读取后台 Usage 消费
  - 极简展示当前余额和累计消费
- Codex
  - 读取本地 Codex rate-limit 快照
  - 展示 5 小时和 1 周额度剩余百分比
  - 展示各窗口下次刷新时间
- 桌面组件
  - 默认折叠小窗
  - 鼠标悬浮显示简化摘要
  - 点击展开完整信息
  - 展开后失焦自动折叠
  - 折叠态自动吸附屏幕侧边
  - 托盘菜单、置顶窗口、安全存储 API Key

## 开发

```powershell
npm install
npm run dev
```

## 构建检查

```powershell
npm run build
```

## 安全说明

DeepSeek API Key 只在 Electron 主进程中使用，并通过 `safeStorage` 加密保存到本机。渲染进程只能通过 preload 暴露的 IPC 方法发起保存、清除和余额查询，不会直接读取密钥。
