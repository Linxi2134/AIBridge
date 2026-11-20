# NapCat 容器部署（内置 QQ Linux 客户端）

这个目录用 Docker 跑一个完整的 QQ 客户端 + NapCat 协议端，配合本系统的「账号接入」页实现扫码登录。

## 为什么需要它

QQ 没有开放个人号接口。NapCat 的做法是：在容器里跑**官方 NTQQ Linux 客户端**，通过 hook 把消息收发暴露成 OneBot 11 协议。镜像里已经打包了 QQ 本体，你不需要单独装。

容器启动后：

```
┌─────────────────────────────────────────┐
│  Docker 容器                             │
│  ┌──────────────┐   ┌─────────────────┐ │
│  │ NTQQ Linux   │←→ │ NapCat (hook)   │ │
│  │ (官方客户端)  │   │ OneBot 11 API   │ │
│  └──────────────┘   └─────────────────┘ │
└─────────────────────────────────────────┘
        ↓ 6099 WebUI      ↓ 3000 HTTP      ↓ 3001 WS
        └────────── 本系统（node server.js）──────────┘
```

## 快速开始

### 1. 安装 Docker

- **Windows / macOS**：[Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux**：`curl -fsSL https://get.docker.com | sh`

装完确认：

```bash
docker --version
docker compose version
```

### 2. 启动容器

```bash
cd deploy
docker compose up -d
```

首次启动会拉镜像（约 700MB），耐心等几分钟。

查看状态：

```bash
docker compose logs -f napcat
```

看到 `WebUI 已启动` 之类的字样就成功了。

### 3. 拿到 WebUI Token

NapCat 首次启动会生成随机 token，存在配置文件里：

```bash
cat napcat/config/webui.json
```

输出类似：

```json
{
  "host": "0.0.0.0",
  "port": 6099,
  "token": "a1b2c3d4e5f6",
  "loginRate": 3
}
```

把 `token` 的值记下来。也可以直接跑：

```bash
# Windows
powershell -c "(Get-Content napcat/config/webui.json | ConvertFrom-Json).token"

# Linux / macOS
grep -o '"token": *"[^"]*"' napcat/config/webui.json
```

### 4. 在本系统扫码

打开本系统 → 左侧「账号接入」：

| 字段 | 填什么 |
|---|---|
| NapCat WebUI 地址 | `http://127.0.0.1:6099` |
| WebUI Token | 上一步拿到的 token |

点「检测连接」，右侧出现二维码，用**手机 QQ 扫码**。登录成功后点「启用为 AI 机器人」，自动配好 OneBot 渠道。

## 关键配置

### 反向 WebSocket 地址

如果想让 NapCat 主动连本系统（推荐），在 NapCat WebUI → 网络配置 → 新建 WebSocket 客户端，地址填：

| 本系统跑在哪 | 填什么 |
|---|---|
| 宿主机（Docker Desktop） | `ws://host.docker.internal:8787/ws/onebot` |
| 宿主机（Linux Docker） | `ws://172.17.0.1:8787/ws/onebot` |
| 同一局域网另一台机器 | `ws://宿主机局域网IP:8787/ws/onebot` |

> 容器里的 `127.0.0.1` 指向容器自己，不是宿主机。这是最容易踩的坑。

### 端口说明

| 端口 | 用途 | 必需 |
|---|---|---|
| 6099 | WebUI，扫码登录与配置 | 是 |
| 3000 | OneBot HTTP API，本系统主动发消息 | 是 |
| 3001 | OneBot 正向 WebSocket | 可选 |

### 数据持久化

`docker-compose.yml` 已挂载两个目录：

- `./napcat/config` — NapCat 配置（含 WebUI token、OneBot 设置）
- `./napcat/qq` — QQ 登录态、消息缓存

**别删这两个目录**，删了就要重新扫码登录。

## 常见问题

**二维码一直不显示 / 显示"获取失败"**
容器刚启动时 QQ 还没跑起来，等 30 秒再试。看日志：`docker compose logs napcat | tail -50`

**扫码后提示"登录环境异常"**
QQ 检测到容器环境。可以尝试：
- 在 compose 里加 `security_opt: [seccomp:unconfined]`
- 或改用宿主机直接装 NapCat（不用容器）

**频繁掉线**
QQ 对第三方客户端风控较严。降低频率、避免群发、不要刚登录就大量操作。

**磁盘被写满**
镜像默认关闭了 core dump。如果还是出现大文件，检查 `napcat/qq` 目录大小。

**换 QQ 号**
`docker compose down`，删掉 `napcat/qq` 目录，重新 `up -d` 扫码。

## 关于微信

**微信 Linux 版跑起来也没用。**

原因不是资源或环境，而是微信 Linux 客户端**没有任何可被程序调用的接口**：

- 它就是个普通 GUI 程序，消息收发全在进程内部
- 社区没有类似 NapCat 的 hook 方案（Linux 版用户基数太小，没人做）
- 要在容器里跑还得配 X11/VNC，资源开销比 QQ 大得多
- 就算跑起来，你也没法让它自动收发消息——只能靠模拟鼠标键盘，极其脆弱

现有能用的微信机器人方案只有三条：

| 方案 | 原理 | 风险 |
|---|---|---|
| WeChatFerry | Hook Windows 微信客户端 | 需特定版本，有封号风险 |
| iPad / Pad 协议 | 逆向微信 iPad 协议 | 付费，违反条款，封号率高 |
| 公众号 / 企微 | 官方接口 | 无风险，但能力受限 |

前两条都违反《微信个人帐号使用规范》，本项目不集成。第三条已经在系统里支持了，用「账号接入 → 微信」生成关注二维码即可。

## 安全提醒

- 容器里的 QQ 是一个**真实登录的账号**，不是沙箱小号
- NapCat 属于第三方协议端，腾讯明确不认可，**存在封号风险**
- 建议用小号测试，不要在主力号上跑
- 不要用这个号做群发、营销、加好友等高频操作

本项目只提供技术对接，账号风险由使用者自行承担。
