# vyce.cloud 自动续期

自动登录 [vyce.cloud](https://vyce.cloud/#/servers) 并点击 **Renew**，让你的免费 VPS 一直保持运行。

- 支持 **API 模式**（默认，稳定、适合定时任务）和 **浏览器点击模式**（真实打开页面点 Renew）
- 每 24 小时自动检查一次；站点有 24 小时冷却，脚本只会在允许续期时动手，不会重复续期
- 支持 GitHub Actions（免服务器）、Docker、systemd、cron、常驻进程
- 内置重试、冷却判断、续期结果校验和清晰的中文日志
- 单元测试 + 本地 mock 集成测试

> **关于“登录”**：vyce.cloud 只提供 GitHub OAuth 登录，没有账号密码接口。所以本工具采用“登录一次、复用会话”的方式：
> 本地运行 `npm run login`，在弹出的浏览器里用 GitHub 登录；脚本会把会话 Cookie 保存到 `.auth/state.json`，之后每次续期都复用它。
> Cookie 过期（日志提示 401）时，重新执行一次 `npm run login` 即可。

## 工作原理

1. `GET /api/me` 验证登录会话；
2. `GET /api/servers` 读取账号下的服务器；
3. 对 `source === "free"` 且“剩余时间 ≤ 24 小时”或“已关机”的服务器，调用 `POST /api/servers/{id}/renew`；
4. 续期成功后站点会增加约 48 小时，并进入 24 小时冷却；脚本再次运行时会自动跳过冷却中的机器。

浏览器模式则打开 `https://vyce.cloud/#/servers`，自动处理站点“先打开赞助页、再点一次 Renew”的逻辑，然后点击真正的 Renew 按钮。

## 快速开始

要求：Node.js **22.9+**（推荐 24）。

```bash
git clone https://github.com/jinking2007/vyce-renew.git
cd vyce-renew
npm install

# 1. 登录一次（会弹出浏览器，用 GitHub 完成登录，含两步验证）
npm run login

# 2. 查看服务器状态
npm run status

# 3. 试运行（只打印计划，不真正续期）
npm run renew -- --dry-run

# 4. 正式续期
npm run renew
```

如果没有图形界面（例如直接 SSH 到 VPS），请在本地电脑执行 `npm run login`，然后把生成的 `.auth/state.json` 上传到服务器同一路径；或者直接把浏览器 Cookie 写入 `.env` 的 `VYCE_COOKIE`（见下文）。

## 每 24 小时自动运行

### 方式一：常驻进程（最简单）

```bash
npm run daemon
```

默认每 24 小时检查一次，可用 `--interval 12` 改成 12 小时。建议配合 `tmux`、`screen` 或下面的 systemd 使用。

### 方式二：Linux cron

```bash
crontab -e
```

加入（每天 03:17 执行，路径改成你的实际路径）：

```cron
17 3 * * * cd /opt/vyce-renew && /usr/bin/npm run renew >> /var/log/vyce-renew.log 2>&1
```

### 方式三：GitHub Actions（无需服务器，推荐）

1. 把本仓库推送到你自己的 GitHub 仓库；
2. 在本地运行 `npm run export-cookie`，复制输出的整行 Cookie；
3. 运行 `npm run setup:actions` 生成 `.github/workflows/renew.yml`，然后提交并推送（也可以手动复制 `deploy/renew.workflow.yml`）；
4. 打开仓库 **Settings → Secrets and variables → Actions → New repository secret**，名称填 `VYCE_COOKIE`，值粘贴刚才的 Cookie；
5. 打开 **Actions → vyce-renew → Run workflow** 手动跑一次验证。

工作流默认每 12 小时检查一次（`17 3,15 * * *` UTC）。因为站点有 24 小时冷却，脚本只会在允许续期的窗口内真正续期，所以实际仍是每 24 小时续期一次；12 小时一次的检查可以避免 GitHub 定时任务延迟导致错过续期窗口。

> GitHub Actions 的 `schedule` 只会在默认分支上运行，且可能延迟几分钟到几十分钟；请把工作流文件放在默认分支。

### 方式四：Docker

```bash
cp .env.example .env
# 编辑 .env，填入 VYCE_COOKIE
docker compose up -d --build
docker compose logs -f
```

### 方式五：systemd

```bash
sudo mkdir -p /opt/vyce-renew
sudo cp -r . /opt/vyce-renew
cd /opt/vyce-renew && sudo npm install --omit=dev
sudo cp deploy/vyce-renew.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vyce-renew
sudo journalctl -u vyce-renew -f
```

## 命令说明

| 命令 | 作用 |
| --- | --- |
| `npm run login` | 打开浏览器，用 GitHub 登录一次，保存 `.auth/state.json` |
| `npm run renew` | 检查并续期到期的免费服务器（API 模式） |
| `npm run renew:ui` | 打开浏览器，真实点击页面上的 Renew 按钮 |
| `npm run status` | 查看账号信息和每台服务器的到期/冷却状态 |
| `npm run daemon` | 常驻运行，默认每 24 小时检查一次 |
| `npm run export-cookie` | 打印 Cookie（stdout），用于配置 `VYCE_COOKIE` |

常用参数：

```bash
npm run renew -- --dry-run     # 只检查，不续期
npm run renew -- --json        # 输出 JSON（便于监控）
npm run daemon -- --once       # 常驻模式只跑一轮
npm run daemon -- --interval 12
npm run renew:ui -- --headed   # 显示浏览器窗口（默认无头）
```

## 环境变量

复制 `.env.example` 为 `.env`，按需修改：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VYCE_COOKIE` | 空 | 浏览器 Cookie 请求头，设置后优先使用，不再读取会话文件 |
| `VYCE_STATE_PATH` | `.auth/state.json` | Playwright 会话文件路径 |
| `VYCE_BASE_URL` | `https://vyce.cloud` | 站点地址 |
| `VYCE_SERVERS` | 空（全部） | 只处理指定服务器，填 ID 或名称，逗号分隔 |
| `VYCE_THRESHOLD_HOURS` | `24` | 剩余时间 ≤ 该值才续期；站点冷却为 24 小时，不建议调大 |
| `VYCE_INTERVAL_HOURS` | `24` | daemon 检查间隔（小时） |
| `VYCE_DRY_RUN` | `false` | 试运行，只打印计划 |
| `VYCE_HEADLESS` | `true` | 浏览器模式是否无头；首次 `login` 始终需要可见窗口 |
| `VYCE_LOGIN_TIMEOUT_SECONDS` | `600` | 等待 GitHub 登录的超时时间 |
| `VYCE_TIMEOUT_MS` | `20000` | 单个 HTTP 请求超时 |

> 在 GitHub Actions 中请使用 `VYCE_COOKIE` Secret，因为浏览器登录需要人工操作。

## 浏览器点击模式

```bash
npx playwright install chromium   # 第一次使用前安装浏览器
npm run renew:ui -- --headed      # 观察整个点击过程
```

脚本会：

1. 用保存的会话打开 `https://vyce.cloud/#/servers`；
2. 找到可点击的 `Renew` / `Renew and start` 按钮（跳过冷却中的按钮）；
3. 第一次点击后站点会弹出赞助页，脚本自动关闭并再点一次；
4. 等待 “Renewed for 2 days” 之类的成功提示并汇总结果。

在无头 Linux 服务器上如提示缺少系统库，可执行 `npx playwright install --with-deps chromium`（需要 root）。

## 文件结构

```
src/
  cli.js           命令行入口（login / renew / status / daemon / export-cookie）
  browser.js       Playwright 登录与真实点击 Renew
  renew.js         续期核心流程
  vyce-client.js   HTTP 客户端（Cookie、超时、重试、错误分类）
  decisions.js     与站点一致的续期/冷却判定
  cookies.js       Cookie 解析与 storageState 读取
  config.js        环境变量
test/              单元测试与 mock 集成测试
deploy/renew.workflow.yml     GitHub Actions 定时任务模板（复制到 .github/workflows/renew.yml）
deploy/            systemd 服务文件
```

## 常见问题

**1. 提示“登录会话无效或已过期”（HTTP 401）**

站点会话会过期。重新运行 `npm run login`，然后更新 `VYCE_COOKIE` Secret / systemd 环境变量，或让容器读取新的 `.auth/state.json`。

**2. 日志显示“冷却中”，是不是没成功？**

不是。站点规定免费服务器每 24 小时只能续期一次，剩余时间大于 24 小时时不能续期。脚本会自动跳过，等冷却结束后的下一次运行再续。

**3. 续期请求返回 `ad_bypassed_too_fast` / 广告校验失败**

站点会检测 Renew 的广告流程。请改用浏览器点击模式：

```bash
npm run renew:ui -- --headed
```

脚本会按站点要求打开并关闭赞助页，然后完成第二次点击。

**4. GitHub Actions 没有按时运行**

- 工作流必须在默认分支；
- `schedule` 在仓库无活动时可能延迟，属正常现象；本项目的 24 小时冷却 + 12 小时检查可以容忍延迟；
- 也可用 `workflow_dispatch` 手动触发。

**5. 登录时 GitHub 要求两步验证**

正常在浏览器里完成即可，`npm run login` 会等待你输入验证码；只要 `/api/me` 不再返回 `mfaPending` 就会保存会话。

**6. 账号提示注册关闭 / 账号太新**

这是站点自身的限制（GitHub 账号需满 30 天等），与脚本无关。

## 安全说明

- `.auth/state.json` 和 `VYCE_COOKIE` 等同于账号登录凭证，**不要提交到 Git**（已在 `.gitignore` 中忽略）；
- GitHub Actions 中请使用 Repository Secret，不要在日志里打印 Cookie；
- 建议给 GitHub 账号开启两步验证，并定期检查仓库 Secret。

## 免责声明

本项目仅用于自动化你自己账号的日常续期操作。使用自动化脚本可能违反站点服务条款，存在账号被限制的风险；请自行评估并承担后果。站点接口或页面结构变化也可能导致脚本失效。
