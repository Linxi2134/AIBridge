# AIBridge v1.0.0

AIBridge 是一个可自部署的 AI 机器人中台：网页管理后台 + 微信 / 企业微信 / QQ 接入 + 任意 OpenAI 兼容模型 + 语音与长期记忆。

## 主要功能

- 网页管理：概览、对话测试、渠道、模型、智能体、语音、记忆、会话与日志
- 渠道接入：微信公众号、企业微信自建应用、QQ 官方机器人、OneBot 11
- 模型服务：OpenAI 兼容接口，支持云端 API、中转站和本地模型
- 智能体：多人设、系统提示词、关键词/渠道路由、工具调用
- 长期记忆：公共记忆 / 用户记忆 / 人格记忆，自动提炼与遗忘曲线
- 语音：云端或本地 STT、TTS，支持 QQ 语音条 SILK 编解码
- 视频理解：自动抽帧后交给视觉模型
- 电脑操控：截屏、鼠标键盘、窗口、启动程序、执行命令（Windows 包完整支持）
- Minecraft：进程内控制、动作层、寻路、自动工具/武器/护甲、存档管理（实验性）

## 下载

- `AIBridge-Windows.zip`：Windows x64，内置 Node、依赖和桌面启动器，解压后运行 `start.bat`
- `AIBridge-Linux.tar.gz`：Linux 源码包，需要 Node.js 18+，执行 `npm install` 后运行 `./start.sh`

## 快速开始

### Windows

1. 解压 `AIBridge-Windows.zip`
2. 双击 `start.bat`
3. 打开 `http://127.0.0.1:8787`
4. 在「模型」页填写自己的 API Key

### Linux

```bash
tar -xzf AIBridge-Linux.tar.gz
cd AIBridge-Linux
npm install
./start.sh
```

需要 Node.js 18+。首次启动会生成 `data/config.json`。

## 配置

所有配置都可以在网页后台完成：

- 模型：添加 OpenAI 兼容提供商、Base URL、API Key 和模型名
- 渠道：按平台提示填写 AppID / Secret / Token / EncodingAESKey
- 智能体：创建人设、系统提示词和路由规则
- 语音：选择云端 STT/TTS，或安装本地模型
- 记忆：开启自动提炼，配置公共记忆与用户记忆

`data/config.json` 含密钥，不要提交到 Git。仓库和发布包只提供 `data/config.example.json`。

## 说明

- 本项目不包含任何 API Key、个人配置、会话、记忆、日志或游戏存档
- 不包含任何模型权重：请使用自己的云端 API，或自行下载 GGUF / STT 模型
- Windows 包不包含 Minecraft 客户端和游戏运行时；首次启动游戏时由内置启动器下载，或自行放置 `runtime/mc`
- Linux 包不包含 Windows 二进制文件；电脑操控的 `ctl.exe` 和 PowerShell 辅助脚本仅 Windows 包提供
- Minecraft 相关能力仍属于实验功能，建议先在小号/测试存档验证

## 文件校验

```text
AIBridge-Windows.zip
SHA-256: 6b77979a869875954b49c3016e6dda4ae50b70423e65e070d4b2feb5b02c9cab

AIBridge-Linux.tar.gz
SHA-256: 526615f8ea5e74811e2748f23269067044fe36350e1087fc422b92b5d99a2eee
```

## 已知限制

- Minecraft 控制仍属实验功能，不同地形和版本可能失败
- 本地 LLM / STT 需要自行下载模型
- Linux 包不包含 Windows 专用的 `ctl.exe` 和 PowerShell 辅助脚本
- 部分渠道接入需要公网回调地址和对应平台审核
