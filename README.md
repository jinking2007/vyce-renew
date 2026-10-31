# vyce.cloud 自动续期

自动登录 [vyce.cloud](https://vyce.cloud/#/servers) 并点击 **Renew**，让你的免费 VPS 一直保持运行。

- 支持 **API 模式**（默认，稳定、适合定时任务）和 **浏览器点击模式**（真实打开页面点 Renew）
- 每 24 小时自动检查一次；站点有 24 小时冷却，脚本只会在允许续期时动手，不会重复续期
- 支持 GitHub Actions（免服务器）、Docker、systemd、cron、常驻进程
- 支持 Telegram 通知：续期成功、部分失败、登录失效时推送到手机；CAPTCHA 自动点击失败时可推送“去续期”按钮
- 站点新增 Bestcap 验证时，自动用真实浏览器点击验证框后完成续期
- 支持 HTTP(S)/SOCKS 代理，可让 API 和浏览器统一走固定出口 IP
- 内置重试、冷却判断、续期结果校验和清晰的中文日志
- 单元测试 + 本地 mock 集成测试

> **关于“登录”**：vyce.cloud 只提供 GitHub OAuth 登录，没有账号密码接口。所以本工具采用“登录一次、复用会话”的方式：
> 本地运行 `npm run login`，在弹出的浏览器里用 GitHub 登录；脚本会把会话 Cookie 保存到 `.auth/state.json`，之后每次续期都复用它。
> Cookie 过期（日志提示 401）时，重新执行一次 `npm run login` 即可。

## ⚠️ 站点新增 CAPTCHA

vyce.cloud 在 2026 年 10 月给续期加了 **Bestcap 人机验证**：`POST /api/servers/{id}/renew` 现在必须携带 `captchaResponse`，而该 token 由浏览器里的 “I'm not a robot” 组件生成。

本工具的处理流程：

1. 先用 API 正常尝试续期（如果后端仍放行，继续全自动）；
2. 如果被 CAPTCHA 拦下，自动启动浏览器（GitHub Actions 用系统自带 Chrome）打开续期弹窗；
3. 模拟真实鼠标移动和点击，勾选 Bestcap 验证框（GitHub Actions 中用 Xvfb 启动有头 Chrome，并模拟广告停留）；
4. 验证通过后，站点会自动完成续期，脚本等待成功提示并发送 Telegram 通知；
5. 如果点击后仍未通过（例如升级成图片题、被风控），才发送 **“需要手动验证”** 消息，附带 **“去完成验证并续期”** 按钮。

这里只模拟真实点击，不伪造 token、不破解验证码；如果站点以后升级验证方式，可能会自动回退到手动提醒。

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

# 第一次使用浏览器登录前，先安装 Chromium
npx playwright install chromium

# 1. 登录一次（会弹出浏览器，用 GitHub 完成登录，含两步验证）
npm run login

# 2. 查看服务器状态
npm run status

# 3. 试运行（只打印计划，不真正续期）
npm run renew -- --dry-run

# 4. 正式续期
npm run renew
```

如果没有图形界面（例如直接 SSH 到 VPS），请在本地电脑执行 `npm run login`，然后把生成的 `.auth/state.json` 上传到服务器同一路径；或者直接把浏览器 Cookie 写入 `.env` 的 `VYCE_COOKIE`（获取方法：登录后按 F12 → Network → 刷新 → 点 `/api/me` 请求 → Request Headers → 复制整行 `Cookie` 的值）。

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
4. 打开仓库 **Settings → Secrets and variables → Actions → New repository secret**，依次添加：
   - `VYCE_COOKIE`：`npm run export-cookie` 输出的 Cookie（必填）
   - `TELEGRAM_BOT_TOKEN`：Telegram 机器人 Token（可选，见下文）
   - `TELEGRAM_CHAT_ID`：接收通知的 chat_id（可选）
5. 打开 **Actions → vyce-renew → Run workflow** 手动跑一次验证。

也可以用 GitHub CLI 一次性写入 Secret：

```bash
gh secret set VYCE_COOKIE
gh secret set TELEGRAM_BOT_TOKEN
gh secret set TELEGRAM_CHAT_ID
```

工作流默认每天运行一次（`17 3 * * *` UTC，即北京时间 11:17）。站点有 24 小时冷却，即使提前运行也不会重复续期；想换时间就修改 cron（北京时间 = UTC + 8）。

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
| `npm run notify-test` | 发送一条 Telegram 测试消息，验证配置 |

常用参数：

```bash
npm run renew -- --dry-run     # 只检查，不续期
npm run renew -- --json        # 输出 JSON（便于监控）
npm run renew -- --no-notify   # 本次不发送 Telegram 通知
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
| `VYCE_COOLDOWN_GRACE_MINUTES` | `5` | 距续期窗口只差几分钟时等待后重试，避免固定时间运行差几秒而跳过 |
| `VYCE_INTERVAL_HOURS` | `24` | daemon 检查间隔（小时） |
| `VYCE_DRY_RUN` | `false` | 试运行，只打印计划 |
| `VYCE_HEADLESS` | `true` | 浏览器模式是否无头；首次 `login` 始终需要可见窗口 |
| `VYCE_CAPTCHA_BROWSER` | `true` | API 被 CAPTCHA 拦下时，是否自动用浏览器点击验证框 |
| `VYCE_CAPTCHA_HEADFUL` | CI 中为 `true` | 用 Xvfb 启动有头 Chrome（更接近真人）；本地默认无头 |
| `VYCE_CAPTCHA_TIMEOUT_SECONDS` | `60` | 等待验证框通过的秒数 |
| `VYCE_BROWSER_CHANNEL` | 空 | 浏览器通道，如 `chrome`；留空优先自带 Chromium，失败回退系统 Chrome |
| `VYCE_PROXY_SERVER` | 空 | 代理地址，如 `http://127.0.0.1:7890` 或 `socks5://...` |
| `VYCE_PROXY_USERNAME` | 空 | 代理用户名（可选） |
| `VYCE_PROXY_PASSWORD` | 空 | 代理密码（可选） |
| `VYCE_LOGIN_TIMEOUT_SECONDS` | `600` | 等待 GitHub 登录的超时时间 |
| `VYCE_TIMEOUT_MS` | `20000` | 单个 HTTP 请求超时 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram 机器人 Token（未填写则不通知） |
| `TELEGRAM_CHAT_ID` | 空 | 接收通知的 chat_id |
| `TELEGRAM_NOTIFY` | `true` | 是否启用通知；设为 `always` 则每天发送状态（即使无需续期） |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Telegram API 地址（一般不用改） |

> 在 GitHub Actions 中请使用 `VYCE_COOKIE` Secret，因为浏览器登录需要人工操作。

## Telegram 通知

续期结果可以推送到 Telegram。所有凭据都通过环境变量 / GitHub Secrets 传入，不会写进代码或日志。

### 1. 创建机器人和获取 chat_id

1. 在 Telegram 搜索 **@BotFather**，发送 `/newbot`，按提示创建机器人，得到形如 `123456:ABC-DEF...` 的 Token；
2. 先给刚创建的机器人发送一条 `/start`（否则机器人无法主动给你发消息）；
3. 获取 chat_id：浏览器打开
   `https://api.telegram.org/bot<你的Token>/getUpdates`，在返回 JSON 里找 `message.chat.id`；
   也可以给 **@userinfobot** 发消息直接查看。

群组通知同理：把机器人拉进群，给它发一条消息，再从 `getUpdates` 里取群的 chat_id（通常是负数）。

### 2. 本地测试

在 `.env` 中填写：

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=123456789
```

然后执行：

```bash
npm run notify-test
```

收到“vyce.cloud 通知测试”即配置成功。

### 3. 配置到 GitHub Secrets

仓库 **Settings → Secrets and variables → Actions** 中添加：

- `VYCE_COOKIE`（必填）
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_NOTIFY`（可选：`true` 默认、`false` 关闭、`always` 每天发状态）

工作流模板已经把这些 Secret 注入到 `npm run renew` 的环境变量中。

### 4. 什么时候会收到通知

- ✅ 有服务器续期成功；
- ⚠️ 有服务器续期失败（部分失败也会发）；
- ❌ 登录失效、网络错误等整体失败；
- 🧪 手动 `--dry-run` 时有计划续期；
- 全部处于冷却期时默认不发送，避免每天刷屏；
- 把 `TELEGRAM_NOTIFY` 设为 `always`，则每天都会收到一条状态消息（即使无需续期）；
- 通知发送失败只记录警告，不会影响续期本身。

> 如果运行成功但没收到消息，先看日志里的“本次结果”：如果显示 `续期 0 台，跳过 1 台`，说明服务器还在冷却期，默认不发通知，这是正常的。想每天都收到一条确认，把 `TELEGRAM_NOTIFY` 设为 `always`。

## 固定 IP / 代理

如果你的节点提供固定出口 IP，把它加进来**通常有助于通过 Bestcap 风控**，因为验证 token 与续期请求会来自同一个稳定 IP。注意：

- **住宅 / 静态 ISP 代理**成功率最高；普通机房代理（VPS）可能仍然被判定为风险 IP；
- 必须是**固定或粘性出口**，不要在验证过程中切换 IP；
- 推荐使用 HTTP(S) 代理端口（Clash / V2Ray 的 mixed 端口即可）；SOCKS5 只有浏览器支持，API 会直连并给出警告；
- 浏览器（验证框 + 站点续期请求）和 Node API 都会走同一个代理。

配置方式：

```dotenv
VYCE_PROXY_SERVER=http://127.0.0.1:7890
VYCE_PROXY_USERNAME=可选
VYCE_PROXY_PASSWORD=可选
```

本地先用 `npm run status` 验证代理是否生效（日志会显示“API 使用代理”）。

GitHub Actions 需要在仓库 Secret 中添加：

- `VYCE_PROXY_SERVER`
- `VYCE_PROXY_USERNAME`（可选）
- `VYCE_PROXY_PASSWORD`（可选）

并确保工作流的 `env:` 中包含这三项（`deploy/renew.workflow.yml` 模板已包含）。如果你用的是之前版本的工作流文件，请把这三行补到 `Renew servers` 步骤的 `env:` 下：

```yaml
          VYCE_PROXY_SERVER: ${{ secrets.VYCE_PROXY_SERVER }}
          VYCE_PROXY_USERNAME: ${{ secrets.VYCE_PROXY_USERNAME }}
          VYCE_PROXY_PASSWORD: ${{ secrets.VYCE_PROXY_PASSWORD }}
```

> 代理密码等同于账号凭据，请只放在 Secret / `.env` 中，不要提交到 Git。
> 如果加了住宅代理仍然失败，说明 Bestcap 还会检测自动化环境或账号行为，代理本身无法解决。

### sing-box + VLESS 怎么接

`vless://` 是节点链接，不是 HTTP 代理，程序不能直接使用。需要让 sing-box 提供一个 **mixed inbound**（同时支持 HTTP 和 SOCKS），然后把地址填给程序。

在 sing-box 配置里加入：

```json
{
  "inbounds": [
    {
      "type": "mixed",
      "tag": "mixed-in",
      "listen": "127.0.0.1",
      "listen_port": 7890,
      "users": [
        { "username": "vyce", "password": "换成强密码" }
      ]
    }
  ]
}
```

保留你原来的 VLESS outbound 和 route（确保最终出口是 VLESS 节点），然后：

```dotenv
VYCE_PROXY_SERVER=http://127.0.0.1:7890
VYCE_PROXY_USERNAME=vyce
VYCE_PROXY_PASSWORD=换成强密码
```

推荐 HTTP 端口（`mixed` 同时支持），因为 API 和浏览器都会走它；纯 SOCKS 端口 API 会直连。

**两种部署方式：**

1. **机器人跑在和 sing-box 同一台机器上（推荐）**
   - 最安全、延迟最低；
   - 直接 `npm run daemon` 或 cron，不需要把代理暴露到公网；
   - 出口 IP 就是 VLESS 节点的 IP。

2. **继续用 GitHub Actions**
   - sing-box 必须运行在**有公网 IP 的服务器**上，`listen` 改成 `0.0.0.0`；
   - 把 `http://公网IP:7890` 和用户名密码存到 Secret；
   - **务必**加防火墙/TLS/强密码，不要把无认证代理暴露公网（会被扫描滥用）；
   - 出口 IP 是 VLESS 节点 IP，住宅/固定 ISP 节点成功率更高，机房节点可能仍被 Bestcap 风控。

GitHub Actions 的连接路径是：

```text
GitHub Runner → 公网 sing-box mixed inbound → VLESS 节点 → vyce.cloud
```

所以真正对 vyce.cloud 展示的 IP 是 VLESS 节点的出口 IP，固定且不轮换才有意义。

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

> 站点新增的 Bestcap CAPTCHA 会在浏览器模式中自动模拟鼠标点击；如果验证升级为图片题或被风控，会停止并提示手动完成。

## 文件结构

```
src/
  cli.js           命令行入口（login / renew / status / daemon / export-cookie）
  browser.js       Playwright 登录与真实点击 Renew
  renew.js         续期核心流程
  vyce-client.js   HTTP 客户端（Cookie、超时、重试、错误分类）
  decisions.js     与站点一致的续期/冷却判定
  cookies.js       Cookie 解析与 storageState 读取
  notify.js        Telegram 通知（消息格式、发送、失败降级）
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
- `schedule` 在仓库无活动时可能延迟，属正常现象；本项目每天检查一次，并受 24 小时冷却保护，提前或延迟一点都不会重复续期；
- 也可用 `workflow_dispatch` 手动触发。

**5. 登录时 GitHub 要求两步验证**

正常在浏览器里完成即可，`npm run login` 会等待你输入验证码；只要 `/api/me` 不再返回 `mfaPending` 就会保存会话。

**6. 账号提示注册关闭 / 账号太新**

这是站点自身的限制（GitHub 账号需满 30 天等），与脚本无关。

**7. 收不到 Telegram 通知**

- 先运行 `npm run notify-test` 自测；
- 确认已经给机器人发送过 `/start`，或已把机器人拉进群；
- 确认 `TELEGRAM_CHAT_ID` 正确（群组 ID 通常是负数）；
- 如果 Secret 中设置了 `TELEGRAM_NOTIFY=false`，通知会被关闭；
- 通知失败不会影响续期，日志里会有“Telegram 通知发送失败”的警告。

## 安全说明

- `.auth/state.json` 和 `VYCE_COOKIE` 等同于账号登录凭证，**不要提交到 Git**（已在 `.gitignore` 中忽略）；
- GitHub Actions 中请使用 Repository Secret，不要在日志里打印 Cookie；
- 建议给 GitHub 账号开启两步验证，并定期检查仓库 Secret。

## 免责声明

本项目仅用于自动化你自己账号的日常续期操作。使用自动化脚本可能违反站点服务条款，存在账号被限制的风险；请自行评估并承担后果。站点接口或页面结构变化也可能导致脚本失效。
