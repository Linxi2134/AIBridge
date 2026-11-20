# AIBridge Android

安卓版是**内核网关 + WebView 管理后台**，不依赖桌面 Windows 环境。

**所有安卓相关文件都在 `D:/AI/android/`：** 工程、APK、SDK、Termux 运行库。

当前版本：`1.1.1`（versionCode 3），版本号在 `version.json` 里维护。

## 与桌面版的差异

已移除：

- Minecraft / 游戏控制 (`/api/game/*`、`/api/mc/*`、`lib/game`、`lib/mc`、`mcmod`)
- 本地模型 (`/api/llm/*`、`lib/llm-local`、llama.cpp)
- 桌面工具（截屏、鼠标键盘、窗口、启动程序、命令执行、游戏控制）
- OneBot 兼容 WS 端口和 Windows NapCat 自启动
- 「账号接入」页面（没有本机 NapCat 可管理）
- 本地语音识别设置项（只有云端 STT）

保留：

- 网页管理后台（概览、对话、渠道、智能体、记忆、会话、日志、设置）
- OpenAI 兼容模型 / DeepSeek / 通义 / Kimi / OpenRouter / 本地局域网模型
- 微信公众号、企业微信、QQ 官方机器人、OneBot（HTTP 方式）
- 云端 STT/TTS
- 长期记忆、工具调用（时间、计算器、HTTP、搜索、记忆、渠道）

## 结构

```
D:/AI/android/
  app/
    AndroidManifest.xml
    res/                     启动图标（自适应图标 + 背景色）
    src/com/aibridge/android/
      MainActivity.java      WebView + 启动等待/失败重试 + 权限 + 外链
      ServerService.java     前台服务(dataSync)，退出界面后 Node 继续跑
      NodeRuntime.java       解压 assets、启动 Termux Node、等待端口就绪
    src/main/assets/
      nodejs-project/        server.js、核心 lib、public（由构建脚本从 女儿/ 同步）
      libs/                  Node 依赖的 Android .so
      ca/cert.pem            HTTPS CA
    src/main/jniLibs/arm64-v8a/libnode_exec.so
  version.json               versionCode / versionName
  build-apk.js               无 Gradle 的 APK 构建脚本（资产同步 + 前端转译）
  build/                     APK 产物与 apk-sha256.txt
  sdk/                       Android SDK 35
  tools/js/                  esbuild（把前端 JS 转译到 Chrome 62）
  tools/termux/              Termux 运行库来源
```

Node 使用 Termux 的 Node 26（`libnode_exec.so` 是可执行的 PIE），在
`nativeLibraryDir` 下执行；依赖库放在 `filesDir/lib`，通过
`LD_LIBRARY_PATH` 加载。服务只监听 `127.0.0.1:8787`，不向局域网暴露。

`assets/nodejs-project` 里的 `server.js`、`public/`、`lib/` 是**构建时从
`D:/AI/女儿/` 同步过来的副本**，不要手改；改源码后重新跑构建脚本即可。桌面专用
模块（`lib/game`、`lib/mc`、`lib/computer*`、`lib/llm-local.js`、`lib/stt-local.js`）
不会被打进 APK。

`public/*.js` 在同步时会用 esbuild 转译到 **Chrome 62**：Android 8.1 自带的 WebView
只有 Chrome 62，不认识 `?.`、`??` 和 class fields，直接放源码会整页白屏。构建脚本
在打包前会再扫一遍产物，发现残留 `?.` / `??` 直接报错。`web-modern/` 是旧流程留下的
中间目录，现在不再参与打包（保留仅供参考）。

`version.json` 控制 `versionCode` / `versionName`，每次发版改这里；版本号变化同时会
让手机端重新解压一次 assets。

## 构建

需要：

- Android SDK：platform 35、build-tools 35.0.0
- JDK 17+（脚本用 `javac` / `keytool` / `jar`）
- esbuild：`cd tools/js && npm install`（仓库里已有 `node_modules` 就不用重装）

```bash
cd D:/AI/android
export ANDROID_SDK_ROOT=D:/AI/android/sdk
node build-apk.js            # 同步 女儿/ 的 Web+Node 代码并打包（arm64 真机包）
node build-apk.js --check    # 只检查 assets 是否与源码一致（CI/提交前）
node build-apk.js --publish  # 打包后复制到 D:/AI/AIBridge.apk
node build-apk.js --abi x86_64   # 模拟器调试包（走 tools/termux/x86_64 的运行时）
# 产物：D:/AI/android/build/aibridge-android.apk / aibridge-android-x86_64.apk
```

真机只发 arm64；`--abi x86_64` 用 Termux x86_64 的 Node 与依赖库打一个同构调试包，
用于在 Android 模拟器（x86_64 系统镜像）里跑完整链路。x86_64 包不会发布，
且和 arm64 包只差 ABI 与运行库，代码完全一致。

源码目录默认是 `D:/AI/女儿`，可用 `AIBRIDGE_SRC` 覆盖。同步时会检测源文件是否
在复制过程中被改动，不一致会自动重试，避免打出前后端版本错位的包。

签名优先用 `release-keystore.properties`（`release.keystore`）；文件缺失或不完整时
回退到 `debug.keystore`，并在输出里提示。换签名后升级安装前要先卸载旧版。

默认打 `arm64-v8a`（真机）；`--abi x86_64` 打模拟器调试包。32 位设备需要另取
对应 ABI 的 Termux Node 与依赖库，并改 `NodeRuntime` 的路径。

## 运行

1. 安装 APK，首次启动会解压 Node 运行时（约 100 MB，只在首次安装/升级后执行一次，
   之后用 `filesDir/asset.stamp` 跳过）并启动前台服务。
2. 等本地网关起来后 WebView 自动进入管理后台；启动失败会显示原因和「重试」按钮，
   不会停在白屏。
3. 在「设置 -> 模型」里填 API Key；在「渠道」里填公众号/企微/QQ 参数。
4. 端口固定从 `8787` 开始；若被占用，server.js 会顺延到 `8788+`，启动等待会扫描
   `8787-8796` 并只认自家 `/api/status`，然后把 WebView 指到实际端口。
5. 日志：
   - 启动过程：`/sdcard/Android/data/com.aibridge.android/files/startup.log`
   - 启动异常：同目录 `startup-error.txt`
   - Node 输出：应用私有目录 `server.log`（超过 2 MB 自动轮转为 `server.log.1`）
   - 已在 Android 8.1 / API 27（OPPO PBAM00，arm64）实测启动
   - 已在模拟器 API 27 x86_64（WebView 61）实测：解压、启动网关、后台渲染、日志流、麦克风权限弹窗
   - 1.1.1（versionCode 3）在模拟器 API 27 x86_64、320×640 窄屏下复测：首次解压 628ms、
     强杀重启 `assets up to date` 后 0.4s 就绪、HOME 后网关保持运行、聊天页窄屏改为「侧栏在上、对话在下」

## 模拟器自测

```bash
# 1) 装 SDK 组件（只需一次）
sdkmanager --sdk_root=D:/AI/android/sdk platform-tools emulator "system-images;android-27;default;x86_64"
avdmanager create avd -n aibridge27 -k "system-images;android-27;default;x86_64" --abi x86_64

# 2) 启动模拟器（无窗口，WHPX 加速）
emulator -avd aibridge27 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect

# 3) 打包并安装 x86_64 调试包
node build-apk.js --abi x86_64
adb install -r build/aibridge-android-x86_64.apk
adb shell am start -n com.aibridge.android/.MainActivity
adb exec-out screencap -p > shot.png
```

API 27 系统镜像自带 WebView 61，正好能验证前端转译是否覆盖旧内核。

## 已知限制

- 仅 ARM64；没有 Gradle/AndroidX，纯平台 API。
- Termux Node 是外部运行时，APK 约 35 MB（压缩后；解压后含 ICU）。
- 没有本地语音识别（sherpa/whisper）；语音走云端接口。
- 没有桌面端 NapCat 自动安装；QQ 个人号需要外部 OneBot 服务。
- 后台保活依赖前台服务；部分厂商 ROM 仍需手动允许自启动。
- Android 13+ 首次启动会请求通知权限，拒绝后前台服务通知不可见（服务仍在跑）。
- Android 15 起 `dataSync` 前台服务单次运行上限约 6 小时，超时会被系统回收，需要重新打开一次 App。
- `release-keystore.properties` 里是明文口令，不要随源码分发；CI 可改用
  `AIBRIDGE_KEYSTORE` / `AIBRIDGE_STORE_PASSWORD` / `AIBRIDGE_KEY_ALIAS` / `AIBRIDGE_KEY_PASSWORD`。
