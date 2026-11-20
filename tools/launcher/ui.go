package main

// 原生窗口层：把管理后台塞进 WebView2，做成一个真正的桌面程序。
//
// 为什么不用 Electron：那要额外背 150MB 内核，而 Win10/11 自带 WebView2 运行时，
// 用纯 Go 绑定（无 CGO）就能拿到同样的 Chromium 内核，产物只多几百 KB。
//
// 和「Edge --app 窗口」的区别：
//   - 是自己的窗口：任务栏图标、标题栏图标、最小尺寸、位置记忆都是自己的
//   - 有托盘：关窗口 = 收进托盘，服务继续跑；托盘里能重启/停止服务
//   - 单实例：重复双击只是把已有窗口叫到前台，不会开第二个
//
// 降级：机器上没装 WebView2 运行时（Win7/8、精简版系统）时返回错误，
// 由 main 退回原来的 Edge --app 方式，功能不受影响。

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

const (
	wmNull          = 0x0000
	wmClose         = 0x0010
	wmSetIcon       = 0x0080
	wmGetMinMaxInfo = 0x0024
	wmExitSizeMove  = 0x0232
	wmLButtonDblClk = 0x0203
	wmRButtonUp     = 0x0205

	hwndBroadcast = 0xFFFF

	swHide     = 0
	swShow     = 5
	swRestore  = 9
	swMaximize = 3

	iconSmall = 0
	iconBig   = 1
	imageIcon = 1

	lrLoadFromFile = 0x0010

	// GWLP_WNDPROC = -4
	gwlpWndProc = ^uintptr(3)

	tpmRightButton = 0x0002
	tpmReturnCmd   = 0x0100

	mfString    = 0x0000
	mfSeparator = 0x0800

	nimAdd    = 0
	nimModify = 1
	nimDelete = 2

	nifMessage = 0x01
	nifIcon    = 0x02
	nifTip     = 0x04

	smCxIcon          = 11
	smCyIcon          = 12
	smCxSmIcon        = 49
	smCySmIcon        = 50
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualScreen = 78
	smCyVirtualScreen = 79

	swpNoZOrder = 0x0004

	// 再小就装不下侧边栏 + 内容区，会挤成一团
	minWinW = 900
	minWinH = 620

	menuOpen    = 1
	menuChat    = 6
	menuReload  = 2
	menuRestart = 3
	menuStop    = 4
	menuExit    = 5

	// 全局快捷键：Ctrl+Alt+J 唤起聊天窗并开始说话
	// 用 J 是因为「说」的拼音首字母，而且和常见软件冲突少
	wmHotkey      = 0x0312
	hotkeyVoiceID = 1
	modAlt        = 0x0001
	modControl    = 0x0002
	modNoRepeat   = 0x4000
	vkKeyJ        = 0x4A

	// WM_APP + 1：托盘回调消息。不能占 WM_APP 本身，WebView2 库拿它在主循环里
	// 派发 Dispatch 队列，被我们截走会导致库的回调永远不执行。
	trayCallbackMsg = 0x8001
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procSetWindowLongPtrW     = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW       = user32.NewProc("CallWindowProcW")
	procGetWindowRect         = user32.NewProc("GetWindowRect")
	procSetWindowPos          = user32.NewProc("SetWindowPos")
	procShowWindow            = user32.NewProc("ShowWindow")
	procIsIconic              = user32.NewProc("IsIconic")
	procIsZoomed              = user32.NewProc("IsZoomed")
	procSetForegroundWindow   = user32.NewProc("SetForegroundWindow")
	procLoadImageW            = user32.NewProc("LoadImageW")
	procCreatePopupMenu       = user32.NewProc("CreatePopupMenu")
	procAppendMenuW           = user32.NewProc("AppendMenuW")
	procTrackPopupMenu        = user32.NewProc("TrackPopupMenu")
	procDestroyMenu           = user32.NewProc("DestroyMenu")
	procGetCursorPos          = user32.NewProc("GetCursorPos")
	procPostMessageW          = user32.NewProc("PostMessageW")
	procSendMessageW          = user32.NewProc("SendMessageW")
	procRegisterWindowMessage = user32.NewProc("RegisterWindowMessageW")
	procSetProcessDPIAware    = user32.NewProc("SetProcessDPIAware")
	procGetSystemMetrics      = user32.NewProc("GetSystemMetrics")
	procFindWindowW           = user32.NewProc("FindWindowW")

	procShellNotifyIconW = shell32.NewProc("Shell_NotifyIconW")
	procCreateMutexW     = kernel32.NewProc("CreateMutexW")

	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procReleaseCapture    = user32.NewProc("ReleaseCapture")
	procSystemParameters  = user32.NewProc("SystemParametersInfoW")
	procCoInitializeEx    = ole32.NewProc("CoInitializeEx")
	procRegisterHotKey    = user32.NewProc("RegisterHotKey")
	procUnregisterHotKey  = user32.NewProc("UnregisterHotKey")
)

type point struct{ X, Y int32 }

type winRect struct{ Left, Top, Right, Bottom int32 }

type minMaxInfo struct {
	PtReserved     point
	PtMaxSize      point
	PtMaxPosition  point
	PtMinTrackSize point
	PtMaxTrackSize point
}

// notifyIconData 对应 NOTIFYICONDATAW（Vista 及以后，x64 下 976 字节）。
// 字段顺序和大小必须严格对齐，否则 Shell_NotifyIcon 直接返回失败。
type notifyIconData struct {
	CbSize           uint32
	HWnd             syscall.Handle
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            syscall.Handle
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         guid
	HBalloonIcon     syscall.Handle
}

// winState 记住窗口上次的位置，下次打开接着用。
type winState struct {
	X   int32 `json:"x"`
	Y   int32 `json:"y"`
	W   int32 `json:"w"`
	H   int32 `json:"h"`
	Max bool  `json:"max"`
}

const (
	trayTipRunning = appName + " · 服务运行中"
	trayTipStopped = appName + " · 服务已停止"
	trayTipBusy    = appName + " · 正在重启…"
)

var (
	deskBaseDir  string
	deskWeb      webview2.WebView
	deskHwnd     uintptr
	deskOrigProc uintptr
	deskShowMsg  uintptr
	deskChatMsg  uintptr
	deskQuitting bool
	deskTrayOn   bool
	deskIconBig  uintptr
	deskIconSm   uintptr
	deskMutex    uintptr

	// openChatOnStart 由 --chat 置位：主窗口起来后顺手把小聊天窗也打开
	openChatOnStart bool

	// 聊天窗是否已加载完、以及「窗口还没起来时按了快捷键」的待办
	chatLoaded   bool
	pendingVoice bool
)

// logLauncher 往 data/logs/launcher.log 追加一行。
// GUI 子系统没有控制台，出问题时用户看不到任何输出，只能靠日志定位。
func logLauncher(baseDir, format string, args ...any) {
	if baseDir == "" {
		return
	}
	lp := filepath.Join(baseDir, "data", "logs", "launcher.log")
	if err := os.MkdirAll(filepath.Dir(lp), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(lp, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"),
		fmt.Sprintf(format, args...))
}

// runDesktop 起一个原生窗口跑管理后台。
//
// 返回值约定：
//   - (true, nil)   窗口跑完了（用户退出），服务按原设计继续在后台
//   - (false, nil)  已经有实例在跑，本次只是把它叫到前台
//   - (false, err)  WebView2 不可用，调用方应退回 Edge --app
func runDesktop(baseDir, url string) (bool, error) {
	// 单实例：第二次双击不该再开一个窗口。用命名互斥量判断，
	// 比 FindWindow 可靠（窗口可能还没建出来）。
	mutexName, _ := syscall.UTF16PtrFromString(`Local\AIBridge.Desktop`)
	h, _, lastErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(mutexName)))
	if errno, ok := lastErr.(syscall.Errno); ok && errno == syscall.ERROR_ALREADY_EXISTS {
		logLauncher(baseDir, "已有实例在运行，唤到前台后退出")
		activateExisting()
		return false, nil
	}
	deskMutex = h
	_ = deskMutex

	deskBaseDir = baseDir

	// 消息循环和 COM 都要求同一个线程，锁住主线程避免 Go 调度器搬走。
	runtime.LockOSThread()

	// 不做 DPI 感知的话，125%/150% 缩放系统会把整个窗口位图拉伸，字是糊的。
	procSetProcessDPIAware.Call()

	icoPath := filepath.Join(baseDir, "app.ico")
	cx, _, _ := procGetSystemMetrics.Call(smCxIcon)
	cy, _, _ := procGetSystemMetrics.Call(smCyIcon)
	deskIconBig = loadIconFile(icoPath, int32(cx), int32(cy))
	scx, _, _ := procGetSystemMetrics.Call(smCxSmIcon)
	scy, _, _ := procGetSystemMetrics.Call(smCySmIcon)
	deskIconSm = loadIconFile(icoPath, int32(scx), int32(scy))

	// 用户数据放 LOCALAPPDATA，不往产品目录里拉一堆 Cache 文件夹
	dataPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "AIBridge", "WebView2")
	_ = os.MkdirAll(dataPath, 0o755)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  dataPath,
		WindowOptions: webview2.WindowOptions{
			Title:  appName,
			Width:  1320,
			Height: 880,
			Center: true,
		},
	})
	if w == nil {
		logLauncher(baseDir, "WebView2 不可用，退回 Edge --app")
		return false, fmt.Errorf("WebView2 运行时不可用")
	}
	deskWeb = w
	deskHwnd = uintptr(w.Window())
	if deskHwnd == 0 {
		return false, fmt.Errorf("窗口创建失败")
	}

	// 子类化窗口过程：库自己的 wndproc 把 WM_CLOSE 直接 DestroyWindow，
	// 那样关窗口就真退了。我们要的是收进托盘，所以先截下来。
	cb := windows.NewCallback(deskWndProc)
	old, _, _ := procSetWindowLongPtrW.Call(deskHwnd, gwlpWndProc, cb)
	deskOrigProc = old

	if deskIconBig != 0 {
		procSendMessageW.Call(deskHwnd, wmSetIcon, iconBig, deskIconBig)
	}
	if deskIconSm != 0 {
		procSendMessageW.Call(deskHwnd, wmSetIcon, iconSmall, deskIconSm)
	}

	// 第二个实例靠这条广播消息唤醒已有窗口
	msgName, _ := syscall.UTF16PtrFromString(`AIBridge.Activate`)
	deskShowMsg, _, _ = procRegisterWindowMessage.Call(uintptr(unsafe.Pointer(msgName)))
	chatMsgName, _ := syscall.UTF16PtrFromString(`AIBridge.OpenChat`)
	deskChatMsg, _, _ = procRegisterWindowMessage.Call(uintptr(unsafe.Pointer(chatMsgName)))

	// 全局快捷键挂主窗口：主窗口一定存在，聊天窗可能还没建
	// 注册失败通常是组合键被别的软件占了，记日志但不影响使用
	ok, _, _ := procRegisterHotKey.Call(deskHwnd, hotkeyVoiceID, modControl|modAlt|modNoRepeat, vkKeyJ)
	if ok != 0 {
		logLauncher(baseDir, "全局快捷键已注册：Ctrl+Alt+J")
	} else {
		logLauncher(baseDir, "全局快捷键 Ctrl+Alt+J 注册失败（可能被其他程序占用）")
	}

	restoreWinState()
	addTray()
	if !deskTrayOn {
		logLauncher(baseDir, "托盘图标注册失败（窗口仍可用）")
	}

	// 网页里的 target="_blank" 在 WebView2 里默认什么都不做（不像浏览器会开新标签页）。
	// 桌面程序里正确做法是交给系统默认浏览器，所以挂个桥。
	_ = w.Bind("openExternal", openExternal)
	w.Init(externalLinkShim)

	w.Navigate(url)
	logLauncher(baseDir, "原生窗口已打开 pid=%d", os.Getpid())

	// 窗口是阻塞的，快捷方式放后台建，别让 PowerShell 冷启动的两秒拖慢开窗。
	// 主流程在 Run 返回后还会调一次，那边有 Once 兜着。
	go ensureShortcutsOnce(baseDir)

	// --chat 启动时顺手把小聊天窗也拉起来
	if openChatOnStart {
		openChatWindow(baseDir, appURL+"/chat.html")
	}

	w.Run()

	removeTray()
	logLauncher(baseDir, "窗口已关闭，服务继续在后台运行")
	return true, nil
}

// externalLinkShim 在页面加载前注入：把「新窗口打开」的链接转交给系统浏览器。
const externalLinkShim = `(function(){
  function open(href){ try { if (window.openExternal) window.openExternal(href); } catch (e) {} }
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    var href = el.getAttribute('href') || '';
    if (el.getAttribute('target') === '_blank' && /^https?:/i.test(href)) {
      e.preventDefault(); e.stopPropagation(); open(href);
    }
  }, true);
  var nativeOpen = window.open;
  window.open = function (u) {
    if (typeof u === 'string' && /^https?:/i.test(u)) { open(u); return null; }
    return nativeOpen ? nativeOpen.apply(window, arguments) : null;
  };
})();`

// openExternal 用系统默认浏览器打开链接。
// 只放行 http/https：这个桥是页面能调到 Go 的入口，不能让任意协议跑起来。
func openExternal(rawURL string) (string, error) {
	u := strings.TrimSpace(rawURL)
	lower := strings.ToLower(u)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return "", fmt.Errorf("只允许 http/https 链接")
	}
	c := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", u)
	c.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedProcess,
	}
	if err := c.Start(); err != nil {
		return "", err
	}
	logLauncher(deskBaseDir, "外部链接交给系统浏览器：%s", u)
	return "", nil
}

// deskWndProc 是我们插在库的窗口过程前面的那一层。
func deskWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmClose:
		if deskQuitting {
			removeTray()
			return callOrigProc(hwnd, msg, wp, lp)
		}
		// 关窗口 = 收进托盘，服务照常跑（和旧版「关窗口不停服务」的约定一致）
		saveWinState()
		procShowWindow.Call(hwnd, swHide)
		return 0
	case wmGetMinMaxInfo:
		r := callOrigProc(hwnd, msg, wp, lp)
		mmi := (*minMaxInfo)(unsafe.Pointer(lp))
		mmi.PtMinTrackSize = point{X: minWinW, Y: minWinH}
		return r
	case wmExitSizeMove:
		saveWinState()
	case trayCallbackMsg:
		switch int32(lp & 0xFFFF) {
		case wmLButtonDblClk:
			showMainWindow()
		case wmRButtonUp:
			showTrayMenu()
		}
		return 0
	}
	if deskShowMsg != 0 && msg == deskShowMsg {
		showMainWindow()
		return 0
	}
	if deskChatMsg != 0 && msg == deskChatMsg {
		// 已经有一个实例在跑时，第二次 --chat 靠这条消息把聊天窗叫出来
		openChatWindow(deskBaseDir, appURL+"/chat.html")
		return 0
	}
	if msg == wmHotkey {
		triggerVoiceHotkey()
		return 0
	}
	return callOrigProc(hwnd, msg, wp, lp)
}

func callOrigProc(hwnd, msg, wp, lp uintptr) uintptr {
	if deskOrigProc == 0 {
		return 0
	}
	r, _, _ := procCallWindowProcW.Call(deskOrigProc, hwnd, msg, wp, lp)
	return r
}

// activateExisting 把已经在跑的窗口叫到前台。
// 先发广播（窗口过程里认这条消息），再兜底 FindWindow——
// 广播可能被 UIPI/会话隔离吞掉，FindWindow 能直接拿到句柄。
func activateExisting() {
	if deskShowMsg == 0 {
		m, _ := syscall.UTF16PtrFromString(`AIBridge.Activate`)
		deskShowMsg, _, _ = procRegisterWindowMessage.Call(uintptr(unsafe.Pointer(m)))
	}
	if deskShowMsg != 0 {
		procPostMessageW.Call(hwndBroadcast, deskShowMsg, 0, 0)
	}
	if openChatOnStart {
		// 带 --chat 再点一次，也应该是「把聊天窗叫出来」，而不是什么都不做
		if m, _ := syscall.UTF16PtrFromString(`AIBridge.OpenChat`); m != nil {
			if id, _, _ := procRegisterWindowMessage.Call(uintptr(unsafe.Pointer(m))); id != 0 {
				procPostMessageW.Call(hwndBroadcast, id, 0, 0)
			}
		}
	}

	cls, _ := syscall.UTF16PtrFromString("webview")
	title, _ := syscall.UTF16PtrFromString(appName)
	if h, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title))); h != 0 {
		procShowWindow.Call(h, swRestore)
		procSetForegroundWindow.Call(h)
	}
}

func showMainWindow() {
	if deskHwnd == 0 {
		return
	}
	if iconic, _, _ := procIsIconic.Call(deskHwnd); iconic != 0 {
		procShowWindow.Call(deskHwnd, swRestore)
	} else {
		procShowWindow.Call(deskHwnd, swShow)
	}
	procSetForegroundWindow.Call(deskHwnd)
}

// ---------------- 托盘 ----------------

func loadIconFile(path string, cx, cy int32) uintptr {
	if path == "" {
		return 0
	}
	if _, err := os.Stat(path); err != nil {
		return 0
	}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	h, _, _ := procLoadImageW.Call(0,
		uintptr(unsafe.Pointer(p)),
		imageIcon,
		uintptr(cx), uintptr(cy),
		lrLoadFromFile)
	return h
}

func fillTip(dst *[128]uint16, s string) {
	for i := range dst {
		dst[i] = 0
	}
	u, err := syscall.UTF16FromString(s)
	if err != nil {
		return
	}
	if len(u) > len(dst) {
		u = u[:len(dst)-1]
		u[len(u)-1] = 0
	}
	copy(dst[:], u)
}

func addTray() {
	nid := notifyIconData{}
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.HWnd = syscall.Handle(deskHwnd)
	nid.UID = 1
	nid.UFlags = nifMessage | nifIcon | nifTip
	nid.UCallbackMessage = trayCallbackMsg
	nid.HIcon = syscall.Handle(deskIconSm)
	fillTip(&nid.SzTip, trayTipRunning)

	r, _, _ := procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
	deskTrayOn = r != 0
}

func setTrayTip(text string) {
	if !deskTrayOn {
		return
	}
	nid := notifyIconData{}
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.HWnd = syscall.Handle(deskHwnd)
	nid.UID = 1
	nid.UFlags = nifTip
	fillTip(&nid.SzTip, text)
	procShellNotifyIconW.Call(nimModify, uintptr(unsafe.Pointer(&nid)))
}

func removeTray() {
	if !deskTrayOn {
		return
	}
	nid := notifyIconData{}
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.HWnd = syscall.Handle(deskHwnd)
	nid.UID = 1
	procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
	deskTrayOn = false
}

func showTrayMenu() {
	h, _, _ := procCreatePopupMenu.Call()
	if h == 0 {
		return
	}
	appendMenuItem(h, menuChat, "聊天窗口")
	appendMenuItem(h, menuOpen, "打开面板")
	appendMenuItem(h, menuReload, "刷新界面")
	procAppendMenuW.Call(h, mfSeparator, 0, 0)
	appendMenuItem(h, menuRestart, "重启服务")
	appendMenuItem(h, menuStop, "停止服务")
	procAppendMenuW.Call(h, mfSeparator, 0, 0)
	appendMenuItem(h, menuExit, "退出（服务继续运行）")

	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))

	// 不先抢前台的话，菜单点外面不会消失，会一直挂在屏幕上
	procSetForegroundWindow.Call(deskHwnd)
	cmd, _, _ := procTrackPopupMenu.Call(h,
		tpmReturnCmd|tpmRightButton,
		uintptr(pt.X), uintptr(pt.Y), 0, deskHwnd, 0)
	procPostMessageW.Call(deskHwnd, wmNull, 0, 0)
	procDestroyMenu.Call(h)

	switch cmd {
	case menuChat:
		openChatWindow(deskBaseDir, appURL+"/chat.html")
	case menuOpen:
		showMainWindow()
	case menuReload:
		reloadUI()
	case menuRestart:
		go restartServiceAsync()
	case menuStop:
		go stopServiceAsync()
	case menuExit:
		deskQuitting = true
		procPostMessageW.Call(deskHwnd, wmClose, 0, 0)
	}
}

func appendMenuItem(menu, id uintptr, text string) {
	t, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	procAppendMenuW.Call(menu, mfString, id, uintptr(unsafe.Pointer(t)))
}

// reloadUI 必须在 UI 线程调用（WebView2 的 COM 对象有线程亲和性）。
func reloadUI() {
	if deskWeb != nil {
		deskWeb.Navigate(appURL)
	}
}

// reloadUIAsync 供后台 goroutine 用：投递到 UI 线程再执行。
func reloadUIAsync() {
	if deskWeb == nil {
		return
	}
	deskWeb.Dispatch(reloadUI)
}

func restartServiceAsync() {
	logLauncher(deskBaseDir, "托盘：重启服务")
	setTrayTip(trayTipBusy)
	stopServer(deskBaseDir)
	for i := 0; i < 20; i++ {
		if pidByPort(portStr) == 0 {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	nodeExe := findNode(deskBaseDir)
	if nodeExe == "" {
		setTrayTip(appName + " · 重启失败：找不到 Node")
		return
	}
	if _, err := startServer(deskBaseDir, nodeExe); err != nil {
		setTrayTip(appName + " · 重启失败")
		return
	}
	if !waitReady() {
		setTrayTip(appName + " · 重启超时")
		return
	}
	setTrayTip(trayTipRunning)
	reloadUIAsync()
}

func stopServiceAsync() {
	logLauncher(deskBaseDir, "托盘：停止服务")
	stopServer(deskBaseDir)
	setTrayTip(trayTipStopped)
	reloadUIAsync()
}

// ---------------- 窗口位置记忆 ----------------

func stateFile() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "AIBridge", "window.json")
}

func loadWinState() (winState, bool) {
	var st winState
	b, err := os.ReadFile(stateFile())
	if err != nil {
		return st, false
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return st, false
	}
	if st.W < minWinW || st.H < minWinH {
		return st, false
	}
	return st, true
}

func restoreWinState() {
	st, ok := loadWinState()
	if !ok {
		return
	}
	// 上次可能在外接显示器上，那个屏现在拔了 → 位置会跑到屏幕外，拉回来
	vx, _, _ := procGetSystemMetrics.Call(smXVirtualScreen)
	vy, _, _ := procGetSystemMetrics.Call(smYVirtualScreen)
	vw, _, _ := procGetSystemMetrics.Call(smCxVirtualScreen)
	vh, _, _ := procGetSystemMetrics.Call(smCyVirtualScreen)
	minX, minY := int32(vx), int32(vy)
	maxX, maxY := minX+int32(vw), minY+int32(vh)
	if st.X < minX-200 || st.Y < minY-200 || st.X > maxX-200 || st.Y > maxY-100 {
		return
	}
	procSetWindowPos.Call(deskHwnd, 0,
		uintptr(st.X), uintptr(st.Y), uintptr(st.W), uintptr(st.H), swpNoZOrder)
	if st.Max {
		procShowWindow.Call(deskHwnd, swMaximize)
	}
}

func saveWinState() {
	if deskHwnd == 0 {
		return
	}
	var r winRect
	if ok, _, _ := procGetWindowRect.Call(deskHwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return
	}
	st, _ := loadWinState()
	zoomed, _, _ := procIsZoomed.Call(deskHwnd)
	if zoomed == 0 {
		// 最大化时 GetWindowRect 拿到的是全屏尺寸，不能当普通尺寸存
		st.X = r.Left
		st.Y = r.Top
		st.W = r.Right - r.Left
		st.H = r.Bottom - r.Top
	}
	st.Max = zoomed != 0
	if st.W < minWinW || st.H < minWinH {
		return
	}

	dir := filepath.Dir(stateFile())
	_ = os.MkdirAll(dir, 0o755)
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(stateFile(), b, 0o644)
}

// ---------------- 聊天窗口（第二个原生窗口） ----------------
//
// 和主窗口是两个独立的 WebView2 实例，各自跑在自己的线程上：
// 主窗口是管理后台（大窗口、可最小化），聊天窗口是常驻的小窗（无边框、置顶）。
// 两个实例必须用不同的用户数据目录——同一个目录在一个进程里只能建一个环境。

const (
	gwlStyle        = ^uintptr(15) // GWL_STYLE = -16
	wsPopup         = 0x80000000
	wsVisible       = 0x10000000
	swpNoSize       = 0x0001
	swpNoMove       = 0x0002
	swpFrameChanged = 0x0020
	swpShowWindow   = 0x0040
	wmNCLButtonDown = 0x00A1
	htCaption       = 2
	spiGetWorkArea  = 0x0030

	chatWinW = 420
	chatWinH = 664
)

var (
	chatMu    sync.Mutex
	chatWeb   webview2.WebView
	chatHwnd  uintptr
	chatOrig  uintptr
	chatAlive bool
)

// openChatWindow 打开聊天窗口；已经开着就只是叫到前面。
func openChatWindow(baseDir, url string) {
	chatMu.Lock()
	h, alive := chatHwnd, chatAlive
	chatMu.Unlock()

	if alive && h != 0 {
		procShowWindow.Call(h, swShow)
		procSetForegroundWindow.Call(h)
		return
	}
	go runChatWindow(baseDir, url)
}

func runChatWindow(baseDir, url string) {
	runtime.LockOSThread()
	// 这是新线程，COM 套间还没初始化（库的 init 只在主线程做过一次）
	procCoInitializeEx.Call(0, 2)

	dataPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "AIBridge", "WebView2-chat")
	_ = os.MkdirAll(dataPath, 0o755)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  dataPath,
		WindowOptions: webview2.WindowOptions{
			Title:  "AIBridge 聊天",
			Width:  chatWinW,
			Height: chatWinH,
		},
	})
	if w == nil {
		logLauncher(baseDir, "聊天窗口创建失败：WebView2 不可用")
		return
	}

	hwnd := uintptr(w.Window())

	// 无边框：标题栏和边框都不要，拖动交给页面的标题区（调 winDrag）。
	// 注意 WS_VISIBLE 也在这个位段里，光写 WS_POPUP 会把窗口变成隐藏的。
	procSetWindowLongPtrW.Call(hwnd, gwlStyle, wsPopup|wsVisible)

	// 摆在工作区右下角，像个小挂件
	var wa winRect
	procSystemParameters.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&wa)), 0)
	if wa.Right <= wa.Left || wa.Bottom <= wa.Top {
		// 拿不到工作区就退回整屏
		sw, _, _ := procGetSystemMetrics.Call(0)
		sh, _, _ := procGetSystemMetrics.Call(1)
		wa = winRect{Right: int32(sw), Bottom: int32(sh)}
	}
	x := wa.Right - chatWinW - 24
	y := wa.Bottom - chatWinH - 24
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	procSetWindowPos.Call(hwnd, ^uintptr(0), // HWND_TOPMOST
		uintptr(x), uintptr(y), chatWinW, chatWinH, swpFrameChanged|swpShowWindow)
	procShowWindow.Call(hwnd, swShow)
	logLauncher(baseDir, "聊天窗口 hwnd=%d 工作区=%d,%d-%d,%d 位置=%d,%d",
		hwnd, wa.Left, wa.Top, wa.Right, wa.Bottom, x, y)

	cb := windows.NewCallback(chatWndProc)
	old, _, _ := procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, cb)
	chatOrig = old

	// 拖动：让系统认为按在标题栏上，比自己算偏移量稳
	_ = w.Bind("winDrag", func() {
		procReleaseCapture.Call()
		procSendMessageW.Call(hwnd, wmNCLButtonDown, htCaption, 0)
	})
	_ = w.Bind("winHide", func() {
		procShowWindow.Call(hwnd, swHide)
	})
	_ = w.Bind("openMain", func() { showMainWindow() })
	_ = w.Bind("openExternal", openExternal)

	// 页面加载完会回调这里。快捷键如果在页面就绪前按下，就攒着，等这一刻再触发
	_ = w.Bind("chatReady", func() {
		chatMu.Lock()
		chatLoaded = true
		pending := pendingVoice
		pendingVoice = false
		chatMu.Unlock()
		if pending {
			startVoiceInChat(w)
		}
	})

	w.Init(externalLinkShim)

	w.Navigate(url)

	chatMu.Lock()
	chatWeb, chatHwnd, chatAlive = w, hwnd, true
	chatMu.Unlock()
	logLauncher(baseDir, "聊天窗口已打开")

	w.Run()

	chatMu.Lock()
	chatAlive, chatHwnd, chatWeb = false, 0, nil
	chatLoaded = false
	chatMu.Unlock()
	logLauncher(baseDir, "聊天窗口已关闭")
}

func chatWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	if msg == wmClose {
		// 关掉只是收起来，托盘里还能再叫出来
		procShowWindow.Call(hwnd, swHide)
		return 0
	}
	if chatOrig != 0 {
		r, _, _ := procCallWindowProcW.Call(chatOrig, hwnd, msg, wp, lp)
		return r
	}
	return 0
}

// triggerVoiceHotkey 响应 Ctrl+Alt+J：把聊天窗叫出来，并开始（或结束）录音。
func triggerVoiceHotkey() {
	chatMu.Lock()
	h, alive, loaded := chatHwnd, chatAlive, chatLoaded
	w := chatWeb
	chatMu.Unlock()

	if !alive || h == 0 {
		// 窗口还没建过：开一个，等页面就绪再触发
		chatMu.Lock()
		pendingVoice = true
		chatMu.Unlock()
		logLauncher(deskBaseDir, "快捷键：聊天窗口未打开，正在创建")
		openChatWindow(deskBaseDir, appURL+"/chat.html")
		return
	}

	procShowWindow.Call(h, swShow)
	procSetForegroundWindow.Call(h)

	if !loaded {
		chatMu.Lock()
		pendingVoice = true
		chatMu.Unlock()
		return
	}
	startVoiceInChat(w)
}

func startVoiceInChat(w webview2.WebView) {
	if w == nil {
		return
	}
	// Eval 必须在那个 WebView 的 UI 线程上跑
	w.Dispatch(func() {
		w.Eval("window.__startVoice && window.__startVoice()")
	})
}
