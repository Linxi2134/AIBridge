// AIBridge 启动器
//
// 把 AIBridge.vbs 的逻辑编译成原生 exe：
//  1. 检查服务是否已在跑（探测 /api/status）
//  2. 没跑就用内置 runtime\node\node.exe 静默拉起 server.js，输出重定向到 data\logs\server.log
//  3. 等服务就绪后用 Edge/Chrome 的 --app 模式开一个无地址栏窗口
//
// 和 VBS 版的区别：
//   - 探测本地服务时强制不走系统代理。机器上开了 HTTP_PROXY 时，
//     VBS 用的 MSXML2.ServerXMLHTTP 会把 127.0.0.1 也丢给代理，拿回 502，
//     于是误判「服务没起来」反复重启。
//   - 启动时把子进程 PID 写进 data\server.pid，--stop 能精确停掉自己拉起的那个。
//
// 用法：
//
//	AIBridge.exe            启动服务并开窗口（默认）
//	AIBridge.exe --stop     停止服务
//	AIBridge.exe --status   只看状态
//	AIBridge.exe --no-window  只启动服务，不开窗口
//	AIBridge.exe --restart  重启
package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	appName         = "AIBridge"
	appURL          = "http://127.0.0.1:8787"
	portStr         = "8787"
	createNoWindow  = 0x08000000
	detachedProcess = 0x00000008

	mbOK          = 0x00000000
	mbIconError   = 0x00000010
	mbIconInfo    = 0x00000040
	mbIconWarning = 0x00000030
	mbTopmost     = 0x00040000
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")

	shell32                  = syscall.NewLazyDLL("shell32.dll")
	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")

	ole32             = syscall.NewLazyDLL("ole32.dll")
	procCoTaskMemFree = ole32.NewProc("CoTaskMemFree")
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// FOLDERID_Desktop {B4BFCC3A-DB2C-424C-B029-7FE99A87C641}
var folderIDDesktop = guid{
	Data1: 0xB4BFCC3A,
	Data2: 0xDB2C,
	Data3: 0x424C,
	Data4: [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41},
}

// ---------------- 基础工具 ----------------

// notify 是给用户看的提示入口。
// 正常双击时弹窗（GUI 子系统没有控制台，只能弹窗）；
// 带 --silent 时静默，靠退出码给脚本判断，避免批处理卡在对话框上。
func notify(text string, flags uintptr) {
	if silent {
		return
	}
	messageBox(text, appName, flags)
}

func messageBox(text, title string, flags uintptr) {
	t, err1 := syscall.UTF16PtrFromString(title)
	b, err2 := syscall.UTF16PtrFromString(text)
	if err1 != nil || err2 != nil {
		return
	}
	procMessageBoxW.Call(0,
		uintptr(unsafe.Pointer(b)),
		uintptr(unsafe.Pointer(t)),
		flags|mbTopmost)
}

// exeDir 返回 exe 所在目录。所有相对路径都以它为基准，
// 这样把整个文件夹拷到别处也能正常工作。
func exeDir() string {
	p, err := os.Executable()
	if err != nil {
		p = os.Args[0]
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	abs, err := filepath.Abs(p)
	if err == nil {
		p = abs
	}
	return filepath.Dir(p)
}

// localClient 返回一个不经过任何代理的 HTTP 客户端。
// 关键：Proxy 必须显式置 nil，否则会读 HTTP_PROXY/HTTPS_PROXY，
// 本地回环请求被丢给代理后返回 502，导致误判服务未启动。
func localClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:             nil,
			DisableKeepAlives: true,
		},
	}
}

func isReady() bool {
	resp, err := localClient(1200 * time.Millisecond).Get(appURL + "/api/status")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

func hiddenCmd(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
	return c
}

// ---------------- 定位依赖 ----------------

func findNode(baseDir string) string {
	// 优先用产品自带的便携 Node，这样目标机不需要装 Node
	local := filepath.Join(baseDir, "runtime", "node", "node.exe")
	if st, err := os.Stat(local); err == nil && !st.IsDir() {
		return local
	}
	if p, err := exec.LookPath("node"); err == nil {
		return p
	}
	return ""
}

func findBrowser() string {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`),
	}
	for _, p := range candidates {
		if p == "" {
			continue
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// ---------------- 服务启停 ----------------

func logPath(baseDir string) string {
	return filepath.Join(baseDir, "data", "logs", "server.log")
}

func pidPath(baseDir string) string {
	return filepath.Join(baseDir, "data", "server.pid")
}

// startServer 静默拉起 server.js。
// 直接给子进程一个日志文件句柄（而不是走 cmd /c 重定向），避免 cmd 的引号转义问题；
// 子进程继承句柄后会一直持有，启动器退出也不影响它继续写日志。
func startServer(baseDir, nodeExe string) (int, error) {
	lp := logPath(baseDir)
	if err := os.MkdirAll(filepath.Dir(lp), 0o755); err != nil {
		return 0, fmt.Errorf("创建日志目录失败: %w", err)
	}
	lf, err := os.OpenFile(lp, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return 0, fmt.Errorf("打开日志文件失败: %w", err)
	}
	defer lf.Close()

	// 每次启动先写一行分隔，方便在日志里定位本次运行
	fmt.Fprintf(lf, "\n===== %s 启动 %s =====\n",
		appName, time.Now().Format("2006-01-02 15:04:05"))

	cmd := exec.Command(nodeExe, "server.js")
	cmd.Dir = baseDir
	cmd.Stdout = lf
	cmd.Stderr = lf
	// DETACHED_PROCESS：子进程自成一个进程组、不继承任何控制台。
	// 这样关掉启动它的黑窗口（或启动器本身退出）都不会把服务带走，
	// 双击启动和从 cmd 里启动行为一致。
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedProcess,
	}
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("启动 node 失败: %w", err)
	}
	pid := cmd.Process.Pid
	_ = os.WriteFile(pidPath(baseDir), []byte(strconv.Itoa(pid)), 0o644)
	// 释放句柄但不等待，服务继续在后台跑
	_ = cmd.Process.Release()
	return pid, nil
}

func readPid(baseDir string) int {
	b, err := os.ReadFile(pidPath(baseDir))
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0
	}
	return n
}

func killTree(pid int) bool {
	if pid <= 0 {
		return false
	}
	c := hiddenCmd("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	return c.Run() == nil
}

// pidByPort 用 netstat 兜底找监听端口的进程。
// 服务可能是 start.bat 或别的方式拉起的，此时没有 pid 文件。
func pidByPort(port string) int {
	c := hiddenCmd("netstat", "-ano")
	out, err := c.Output()
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		if !strings.EqualFold(f[0], "TCP") {
			continue
		}
		if !strings.HasSuffix(f[1], ":"+port) {
			continue
		}
		if !strings.EqualFold(f[3], "LISTENING") {
			continue
		}
		if n, err := strconv.Atoi(f[4]); err == nil {
			return n
		}
	}
	return 0
}

func stopServer(baseDir string) bool {
	stopped := false
	if pid := readPid(baseDir); pid > 0 {
		if killTree(pid) {
			stopped = true
		}
	}
	if pid := pidByPort(portStr); pid > 0 {
		if killTree(pid) {
			stopped = true
		}
	}
	_ = os.Remove(pidPath(baseDir))
	return stopped
}

// waitReady 轮询等服务就绪，最多 30 秒。
func waitReady() bool {
	for i := 0; i < 60; i++ {
		if isReady() {
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// ---------------- 开窗口 ----------------

func openWindow(browser string) error {
	profileDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "AIBridge", "window")
	_ = os.MkdirAll(profileDir, 0o755)

	if browser == "" {
		// 没有 Edge/Chrome 时退回系统默认浏览器，至少能打开页面
		c := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", appURL)
		c.SysProcAttr = &syscall.SysProcAttr{
			HideWindow:    true,
			CreationFlags: detachedProcess,
		}
		return c.Start()
	}

	cmd := exec.Command(browser,
		"--app="+appURL,
		"--user-data-dir="+profileDir,
		"--window-size=1320,880",
		"--no-first-run",
		"--no-default-browser-check",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    false,
		CreationFlags: detachedProcess,
	}
	return cmd.Start()
}

// ---------------- 快捷方式 ----------------

// ensureShortcut 用 PowerShell 的 WScript.Shell COM 建快捷方式。
// Go 里直接玩 COM 要写一大堆 syscall，这里一次性建完就不再碰，出错也不影响启动。
func ensureShortcut(lnkPath, exePath, workDir, iconPath string) {
	// 必须先删：WScript.Shell 的 CreateShortcut 遇到已存在的 .lnk 是「打开再改」，
	// 旧的目标路径、相对路径、LinkInfo 会残留在文件里。项目换过盘符（D:→F:）后
	// 残留的旧 vbs 路径会让人以为快捷方式没更新。
	_ = os.Remove(lnkPath)

	q := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	script := fmt.Sprintf(
		"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');"+
			"$s.TargetPath='%s';$s.WorkingDirectory='%s';$s.IconLocation='%s,0';"+
			"$s.Description='%s - AI 接入网关';$s.Save()",
		q(lnkPath), q(exePath), q(workDir), q(iconPath), appName)

	c := hiddenCmd("powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script)
	_ = c.Run()
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// ensureShortcutsOnce 让「建快捷方式」只跑一次。
// 原生窗口是阻塞的（Run 一直到关窗才返回），所以窗口一打开就在后台建；
// 窗口关掉后主流程还会再调一次，用 Once 去重。
var shortcutOnce sync.Once

func ensureShortcutsOnce(baseDir string) {
	shortcutOnce.Do(func() { setupShortcuts(baseDir) })
}

// setupShortcuts 保证根目录和桌面各有一个指向本 exe 的快捷方式。
//
// 判断「要不要重建」靠一个标记文件 data\.shortcut-exe，里面记着上次建快捷方式时
// exe 的绝对路径。项目整个目录搬家后标记里的路径就对不上了，自动重建。
//
// 为什么不直接读 .lnk 判断：.lnk 里目标路径是拆成好几段存的（LinkInfo 的
// 盘符+目录、RelativePath、WorkingDirectory 各存一部分，还混着 ANSI 和 UTF-16），
// 想从中可靠地还原出「它指向哪个 exe」得完整解析格式，不值当。
func setupShortcuts(baseDir string) {
	exe, err := os.Executable()
	if err != nil {
		return
	}

	marker := filepath.Join(baseDir, "data", ".shortcut-exe")
	rootLnk := filepath.Join(baseDir, appName+".lnk")

	desktop := desktopDir()
	deskLnk := ""
	if desktop != "" {
		deskLnk = filepath.Join(desktop, appName+".lnk")
	}

	// 标记对得上、两个快捷方式也都还在，就什么都不用做
	if prev, err := os.ReadFile(marker); err == nil &&
		strings.TrimSpace(string(prev)) == exe &&
		fileExists(rootLnk) && (deskLnk == "" || fileExists(deskLnk)) {
		return
	}

	icon := filepath.Join(baseDir, "app.ico")
	if !fileExists(icon) {
		icon = exe
	}

	ensureShortcut(rootLnk, exe, baseDir, icon)
	if deskLnk != "" {
		ensureShortcut(deskLnk, exe, baseDir, icon)
	}

	_ = os.WriteFile(marker, []byte(exe), 0o644)
}

// desktopDir 拿桌面真实路径。
// 走 SHGetKnownFolderPath 而不是读注册表：OneDrive 接管桌面、多用户、
// 企业重定向这些情况下注册表值可能是未展开的 %USERPROFILE%，而且 reg.exe
// 在某些安全策略下会被禁用。系统 API 一步到位。
func desktopDir() string {
	// 直接拿 *uint16，避免 uintptr→unsafe.Pointer 的往返（那是不安全且会被 vet 拦的写法）
	var p *uint16
	hr, _, _ := procSHGetKnownFolderPath.Call(
		uintptr(unsafe.Pointer(&folderIDDesktop)), 0, 0,
		uintptr(unsafe.Pointer(&p)))
	if hr == 0 && p != nil {
		defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
		if s := utf16PtrToString(p); s != "" {
			if st, err := os.Stat(s); err == nil && st.IsDir() {
				return s
			}
		}
	}
	// 兜底：常规位置
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, "Desktop")
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
	}
	return ""
}

// utf16PtrToString 把 Windows 返回的以 \0 结尾的宽字符串转成 Go string。
func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	var n int
	for ptr := unsafe.Pointer(p); *(*uint16)(ptr) != 0; ptr = unsafe.Add(ptr, 2) {
		n++
	}
	if n == 0 {
		return ""
	}
	return syscall.UTF16ToString((*[1 << 20]uint16)(unsafe.Pointer(p))[:n:n])
}

// ---------------- 主流程 ----------------

// silent 为真时不弹任何对话框，改用退出码表达结果，方便批处理调用。
var silent bool

func main() {
	baseDir := exeDir()

	var doStopFlag, doStatus, noWindow, doRestart, doHelp bool
	for _, a := range os.Args[1:] {
		switch strings.ToLower(a) {
		case "--silent", "-silent", "-q", "--quiet":
			silent = true
		case "--stop", "-stop", "/stop":
			doStopFlag = true
		case "--status", "-status", "/status":
			doStatus = true
		case "--no-window", "-no-window":
			noWindow = true
		case "--chat", "-chat":
			openChatOnStart = true
		case "--restart", "-restart":
			doRestart = true
		case "--help", "-h", "/?", "--version":
			doHelp = true
		}
	}

	if doHelp {
		notify(
			"AIBridge 启动器\n\n"+
				"双击             启动服务并打开窗口\n"+
				"--chat           顺便打开语音聊天窗口\n"+
				"--stop           停止服务\n"+
				"--status         查看运行状态\n"+
				"--restart        重启服务\n"+
				"--no-window      只启动服务，不开窗口\n"+
				"--silent         不弹窗，用退出码表示结果",
			mbIconInfo|mbOK)
		return
	}

	// 校验这是不是产品目录：server.js 必须存在
	if _, err := os.Stat(filepath.Join(baseDir, "server.js")); err != nil {
		notify(
			"找不到 server.js。\n\n"+
				"请把 AIBridge.exe 放在 AIBridge 目录里再运行，\n"+
				"不要单独把它拷出来。\n\n目录："+baseDir,
			mbIconError|mbOK)
		os.Exit(1)
	}

	if doStopFlag {
		if stopServer(baseDir) {
			notify("服务已停止。\n\nQQ 机器人会离线。", mbIconInfo|mbOK)
			return
		}
		notify("没有正在运行的服务。", mbIconInfo|mbOK)
		os.Exit(1)
	}

	if doStatus {
		if isReady() {
			notify("服务运行中。\n\n"+appURL, mbIconInfo|mbOK)
			return
		}
		notify("服务未运行。", mbIconWarning|mbOK)
		os.Exit(1)
	}

	if doRestart {
		stopServer(baseDir)
		// 等端口真正释放，否则新进程会 EADDRINUSE
		for i := 0; i < 20; i++ {
			if pidByPort(portStr) == 0 {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}

	// 已经跑着就只开窗口，不重复拉起
	if !isReady() {
		nodeExe := findNode(baseDir)
		if nodeExe == "" {
			notify(
				"找不到 Node 运行时。\n\n"+
					"正常情况下产品目录里应该有：\n"+
					"  runtime\\node\\node.exe\n\n"+
					"如果这个文件不见了，请重新解压完整的产品包，\n"+
					"或者安装 Node.js 18+ ：https://nodejs.org",
				mbIconError|mbOK)
			os.Exit(1)
		}

		if _, err := startServer(baseDir, nodeExe); err != nil {
			notify("启动失败："+err.Error(), mbIconError|mbOK)
			os.Exit(1)
		}

		if !waitReady() {
			notify(
				"服务启动超时，30 秒内没有响应。\n\n"+
					"日志："+logPath(baseDir)+"\n\n"+
					"常见原因：端口 8787 被别的程序占用。",
				mbIconError|mbOK)
			os.Exit(1)
		}
	}

	if !noWindow {
		// 先试原生窗口（WebView2）；跑不起来再退回 Edge --app，
		// 保证在没装 WebView2 运行时的机器上依然能用。
		created, derr := runDesktop(baseDir, appURL)
		switch {
		case derr == nil && !created:
			// 已经有实例在跑，刚才只是把它叫到前台，不用再开第二个
			return
		case derr != nil:
			if err := openWindow(findBrowser()); err != nil {
				notify(
					"服务已启动，但打开窗口失败："+err.Error()+"\n\n"+
						"可以手动在浏览器访问："+appURL,
					mbIconWarning|mbOK)
			}
		}
	}

	// 快捷方式放在开窗之后同步做：先把界面给用户，PowerShell 冷启动的
	// 一两秒在后台耗掉。不能用 goroutine——main 返回进程就退出，
	// 建快捷方式的子进程会被连带掐断。
	ensureShortcutsOnce(baseDir)
}
