# AIBridge

一个可自部署的 AI 机器人中台：网页管理后台 + 微信 / 企业微信 / QQ 接入 + 任意 OpenAI 兼容模型 + 语音、长期记忆、知识库与视频生成。

核心服务零第三方依赖，只需要 Node.js 18+；语音、视频和本地模型能力可按需安装。

[![offline-tests](https://github.com/Linxi2134/AIBridge/actions/workflows/test.yml/badge.svg)](https://github.com/Linxi2134/AIBridge/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 功能

- **网页管理**：概览、对话测试、渠道配置、模型管理、智能体、语音、记忆、知识库、技能、视频生成、会话记录、运行日志
- **渠道接入**：微信公众号（明文模式 / 安全模式）、企业微信自建应用（AES 加密）、QQ 官方机器人（Ed25519 验签）、OneBot 11 个人 QQ（HTTP + WebSocket）
- **消息理解**：群聊识别发送者、多模态图片、引用回复、QQ 语音条、视频抽帧
- **模型服务**：任意 OpenAI 兼容接口，包括官方 API、DeepSeek、通义、Kimi、硅基流动、中转站和本地 Ollama
- **智能体**：多人设、系统提示词、温度、Token 上限、按渠道/关键词路由
- **长期记忆**：公共记忆 / 用户记忆 / 人格记忆，自动提炼，按遗忘曲线衰减与加固；曲线可一键关闭（记忆恒为 100%，永不遗忘）
- **记忆库**：关键词检索、清晰度/标签/沉睡筛选、分页、批量归档或删除
- **知识库**：导入 txt / md / json / csv / html / docx / xlsx（PDF、doc 走本机转换器），自动分块 + BM25 检索，命中片段按需注入对话
- **技能包**：安装 `skill.json` 技能包并分配给智能体；技能只注入提示词，不能提权
- **视频生成**：文生/图生视频，支持 OpenAI 兼容 `/v1/videos`、MiniMax 海螺、火山方舟 Seedance、智谱 CogVideoX 与自定义接口
- **主动操控**：AI 可主动发消息、查好友/群列表、查群成员和最近会话
- **工具调用**：时间、计算器、HTTP、联网搜索、记忆读写、知识库检索、视频生成、渠道操作
- **语音输入/输出**：云端或本地 STT，TTS 播放，QQ 语音条 SILK 编解码
- **视频理解**：ffmpeg 自适应抽帧，按时间顺序交给视觉模型
- **电脑操控**：截屏、鼠标、键盘、窗口、启动程序、执行命令（Windows 完整支持）
- **Minecraft 进程内控制（实验性）**：动作层、自动寻路、工具/武器/护甲选择、存档管理、分阶段教程

## 快速开始

### Windows 发布包

1. 解压 `AIBridge-Windows.zip`
2. 双击 `start.bat`
3. 打开 `http://127.0.0.1:8787`
4. 在「模型」页填写自己的 API Key

发布包内置 Node、依赖和桌面启动器，不包含 API Key、个人数据和模型权重。

### Linux 源码包

```bash
tar -xzf AIBridge-Linux.tar.gz
cd AIBridge-Linux
npm install
./start.sh
```

需要 Node.js 18+。首次启动会生成 `data/config.json`。

### Android 安装包

到 [Releases](https://github.com/Linxi2134/AIBridge/releases) 下载 `AIBridge.apk`（当前 1.2.0 / versionCode 4，Android 8.0+，arm64，应用内自带网关），
首次启动会解压内置运行时（约 100MB）。构建、`--check` 同步校验与模拟器自测命令见 `android/README.md`。

### 从源码运行

```bash
git clone https://github.com/Linxi2134/AIBridge.git AIBridge
cd AIBridge
npm install
node server.js
```

打开 `http://127.0.0.1:8787`。

## 配置

所有配置都可以在网页后台完成：

- **模型**：添加 OpenAI 兼容提供商、Base URL、API Key 和模型名
- **渠道**：按平台提示填写 AppID / Secret / Token / EncodingAESKey
- **智能体**：创建人设、系统提示词和路由规则
- **语音**：选择云端 STT/TTS，或安装本地模型
- **记忆**：开启自动提炼，配置公共记忆与用户记忆

`data/config.json` 含密钥，不要提交到 Git。仓库和发布包只提供 `data/config.example.json`。

## 目录结构

```text
AIBridge/
├─ server.js              # 网关入口
├─ lib/                   # 渠道、模型、记忆、语音、游戏控制
├─ public/                # 网页管理后台
├─ mcmod/                 # Minecraft 客户端控制 mod 源码与构建脚本
├─ tests/                 # 自测与集成测试
├─ data/                  # 运行时配置、会话、索引（不提交密钥）
├─ runtime/               # Node / Minecraft / 模型等本地运行时
├─ start.bat              # Windows 启动
└─ start.sh               # Linux / macOS 启动
```

## Minecraft 控制

`mcmod/` 通过 Java agent 在客户端进程内调用游戏 API，不模拟鼠标键盘。需要：

- JDK 25+
- Minecraft 26.3 客户端
- 首次运行前把游戏运行时放到 `runtime/mc`，或使用内置启动器下载

编译 mod：

```bash
node mcmod/build.js
```

Minecraft 相关能力仍在持续验证，建议先在测试存档使用。

## 安全说明

- 不要提交 `data/config.json`、`data/sessions.json`、`data/memory.json` 或游戏存档
- 发布包不包含 API Key、QQ 号、会话、日志和个人配置
- 电脑操控默认关闭，开启前请确认只允许可信用户访问
- 公网部署时请在反向代理层增加认证和 HTTPS

## 发布包

- `AIBridge-Windows.zip`：Windows x64，内置 Node 和依赖，解压后 `start.bat`
- `AIBridge-Linux.tar.gz`：Linux 源码包，执行 `npm install` 后 `./start.sh`

两个包都不包含模型权重、Minecraft 客户端和个人数据。

## 已知限制

- Minecraft 控制仍属实验功能，不同地形和版本可能失败
- 本地 LLM / STT 需要自行下载模型
- Linux 包不包含 Windows 专用的 `ctl.exe` 和 PowerShell 辅助脚本
- 部分渠道接入需要公网回调地址和对应平台审核

## License

[MIT](LICENSE) © 2026 Linxi2134

可以自由使用、修改、分发，商用也行；保留版权与许可声明即可。项目不包含任何 API Key、个人配置、会话、记忆或模型权重，使用前请阅读上文「安全说明」。

欢迎 issue / PR。提交前建议本地跑一遍离线测试：

```bash
npm run test:memory-curve
npm run test:kb && npm run test:skills && npm run test:video-gen
```
