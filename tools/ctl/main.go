// AIBridge 电脑操控后端（原生实现）
//
// 为什么不用 PowerShell：
//  1. 每调一次冷启动 300~600ms，agent 一次任务要调十几次，慢得没法用
//  2. Add-Type + keybd_event/mouse_event 是典型恶意脚本特征，会被 AMSI 直接拦掉
//  3. .ps1 的 UTF-8/ANSI/BOM 编码问题会把中文注释变成语法错误
//     原生 exe 一次启动 10ms，没有这些麻烦。
//
// 用法：ctl.exe <动作> <参数JSON文件>
// 输出：一行 JSON 到 stdout
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pGetDC              = user32.NewProc("GetDC")
	pReleaseDC          = user32.NewProc("ReleaseDC")
	pGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	pSetProcessDPIAware = user32.NewProc("SetProcessDPIAware")
	pSetCursorPos       = user32.NewProc("SetCursorPos")
	pGetCursorPos       = user32.NewProc("GetCursorPos")
	pMouseEvent         = user32.NewProc("mouse_event")
	pKeybdEvent         = user32.NewProc("keybd_event")
	pEnumWindows        = user32.NewProc("EnumWindows")
	pGetWindowTextW     = user32.NewProc("GetWindowTextW")
	pIsWindowVisible    = user32.NewProc("IsWindowVisible")
	pIsIconic           = user32.NewProc("IsIconic")
	pSetForeground      = user32.NewProc("SetForegroundWindow")
	pShowWindow         = user32.NewProc("ShowWindow")
	pGetWindowRect      = user32.NewProc("GetWindowRect")
	pGetForeground      = user32.NewProc("GetForegroundWindow")

	pCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	pSelectObject           = gdi32.NewProc("SelectObject")
	pBitBlt                 = gdi32.NewProc("BitBlt")
	pStretchBlt             = gdi32.NewProc("StretchBlt")
	pSetStretchBltMode      = gdi32.NewProc("SetStretchBltMode")
	pSetBrushOrgEx          = gdi32.NewProc("SetBrushOrgEx")
	pGetDIBits              = gdi32.NewProc("GetDIBits")
	pDeleteObject           = gdi32.NewProc("DeleteObject")
	pDeleteDC               = gdi32.NewProc("DeleteDC")

	pOpenClipboard    = user32.NewProc("OpenClipboard")
	pCloseClipboard   = user32.NewProc("CloseClipboard")
	pEmptyClipboard   = user32.NewProc("EmptyClipboard")
	pSetClipboardData = user32.NewProc("SetClipboardData")
	pGetClipboardData = user32.NewProc("GetClipboardData")
	pGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	pGlobalLock       = kernel32.NewProc("GlobalLock")
	pGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
	pGlobalSize       = kernel32.NewProc("GlobalSize")
)

const (
	srcCopy       = 0x00CC0020
	halftone      = 4
	cfUnicodeText = 13
	gmemMoveable  = 0x0002

	mouseLeftDown  = 0x0002
	mouseLeftUp    = 0x0004
	mouseRightDown = 0x0008
	mouseRightUp   = 0x0010
	mouseMidDown   = 0x0020
	mouseMidUp     = 0x0040
	mouseWheel     = 0x0800
	keyup          = 0x0002

	smXVirtual  = 76
	smYVirtual  = 77
	smCXVirtual = 78
	smCYVirtual = 79
)

type rect struct{ Left, Top, Right, Bottom int32 }
type point struct{ X, Y int32 }

// 参数表：从 JSON 文件读，避免命令行传中文的编码问题
var args map[string]interface{}

func argStr(k, def string) string {
	if v, ok := args[k]; ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return def
}

func argInt(k string, def int) int {
	if v, ok := args[k]; ok {
		switch n := v.(type) {
		case float64:
			return int(n)
		case string:
			if i, err := strconv.Atoi(n); err == nil {
				return i
			}
		}
	}
	return def
}

func argBool(k string, def bool) bool {
	if v, ok := args[k]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return def
}

func has(k string) bool {
	v, ok := args[k]
	return ok && v != nil
}

func emit(v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		os.Stdout.WriteString(`{"ok":false,"error":"结果序列化失败"}`)
		os.Exit(1)
	}
	os.Stdout.Write(b)
	os.Exit(0)
}

func fail(msg string) {
	emit(map[string]interface{}{"ok": false, "error": msg})
}

func ok(m map[string]interface{}) {
	m["ok"] = true
	emit(m)
}

// ---------------- 屏幕 ----------------

func virtualScreen() (x, y, w, h int) {
	g := func(idx int) int {
		r, _, _ := pGetSystemMetrics.Call(uintptr(idx))
		return int(int32(r))
	}
	return g(smXVirtual), g(smYVirtual), g(smCXVirtual), g(smCYVirtual)
}

// capture 截取虚拟屏幕，必要时等比缩放到 maxWidth，返回 JPEG 字节和实际尺寸
func capture(maxWidth, quality int) ([]byte, int, int, float64, error) {
	vx, vy, vw, vh := virtualScreen()
	if vw <= 0 || vh <= 0 {
		return nil, 0, 0, 0, fmt.Errorf("拿不到屏幕尺寸")
	}

	hdcScreen, _, _ := pGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, 0, 0, 0, fmt.Errorf("获取屏幕 DC 失败")
	}
	defer pReleaseDC.Call(0, hdcScreen)

	hdcMem, _, _ := pCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, 0, 0, 0, fmt.Errorf("创建内存 DC 失败")
	}
	defer pDeleteDC.Call(hdcMem)

	outW, outH := vw, vh
	scale := 1.0
	if maxWidth > 0 && vw > maxWidth {
		scale = float64(maxWidth) / float64(vw)
		outW = maxWidth
		outH = int(float64(vh) * scale)
		if outH < 1 {
			outH = 1
		}
	}

	// 直接按目标尺寸建位图：缩放也在这一张上完成，
	// 不再「先抓原图再缩」——那样得在内存 DC 里来回切位图，
	// 一不小心就在源位图被取消选中的状态下采样，抓出全黑图。
	bmp, _, _ := pCreateCompatibleBitmap.Call(hdcScreen, uintptr(outW), uintptr(outH))
	if bmp == 0 {
		return nil, 0, 0, 0, fmt.Errorf("创建位图失败")
	}
	defer pDeleteObject.Call(bmp)

	old, _, _ := pSelectObject.Call(hdcMem, bmp)

	if outW == vw && outH == vh {
		pBitBlt.Call(hdcMem, 0, 0, uintptr(outW), uintptr(outH),
			hdcScreen, uintptr(vx), uintptr(vy), srcCopy)
	} else {
		// HALFTONE 是 GDI 里质量最好的缩放模式，配合 SetBrushOrgEx 消除网格感
		pSetStretchBltMode.Call(hdcMem, halftone)
		pSetBrushOrgEx.Call(hdcMem, 0, 0, 0)
		pStretchBlt.Call(hdcMem, 0, 0, uintptr(outW), uintptr(outH),
			hdcScreen, uintptr(vx), uintptr(vy), uintptr(vw), uintptr(vh), srcCopy)
	}

	pSelectObject.Call(hdcMem, old)

	// 取像素：32 位 BGRA，负数高度表示自上而下
	type bitmapInfoHeader struct {
		BiSize          uint32
		BiWidth         int32
		BiHeight        int32
		BiPlanes        uint16
		BiBitCount      uint16
		BiCompression   uint32
		BiSizeImage     uint32
		BiXPelsPerMeter int32
		BiYPelsPerMeter int32
		BiClrUsed       uint32
		BiClrImportant  uint32
	}
	type bitmapInfo struct {
		BmiHeader bitmapInfoHeader
		BmiColors [1]uint32
	}

	var bi bitmapInfo
	bi.BmiHeader.BiSize = uint32(unsafe.Sizeof(bi.BmiHeader))
	bi.BmiHeader.BiWidth = int32(outW)
	bi.BmiHeader.BiHeight = int32(-outH)
	bi.BmiHeader.BiPlanes = 1
	bi.BmiHeader.BiBitCount = 32
	bi.BmiHeader.BiCompression = 0 // BI_RGB

	buf := make([]byte, outW*outH*4)
	r1, _, _ := pGetDIBits.Call(hdcMem, bmp, 0, uintptr(outH),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&bi)), 0)
	if int(r1) == 0 {
		return nil, 0, 0, 0, fmt.Errorf("读取像素失败")
	}

	// BGRA → RGBA
	img := image.NewRGBA(image.Rect(0, 0, outW, outH))
	for i := 0; i < outW*outH; i++ {
		s := i * 4
		d := i * 4
		img.Pix[d+0] = buf[s+2]
		img.Pix[d+1] = buf[s+1]
		img.Pix[d+2] = buf[s+0]
		img.Pix[d+3] = 255
	}

	var out bytes.Buffer
	if quality < 1 || quality > 100 {
		quality = 62
	}
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, 0, 0, 0, err
	}
	return out.Bytes(), outW, outH, scale, nil
}

func foregroundTitle() string {
	h, _, _ := pGetForeground.Call()
	if h == 0 {
		return ""
	}
	buf := make([]uint16, 512)
	pGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf)
}

// ---------------- 窗口 ----------------

type winInfo struct {
	Title     string `json:"title"`
	X         int    `json:"x"`
	Y         int    `json:"y"`
	W         int    `json:"w"`
	H         int    `json:"h"`
	Minimized bool   `json:"minimized"`
}

func listWindows() []winInfo {
	var out []winInfo
	cb := syscall.NewCallback(func(h uintptr, l uintptr) uintptr {
		vis, _, _ := pIsWindowVisible.Call(h)
		if vis == 0 {
			return 1
		}
		buf := make([]uint16, 512)
		pGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		title := syscall.UTF16ToString(buf)
		if title == "" {
			return 1
		}
		var r rect
		pGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
		ico, _, _ := pIsIconic.Call(h)
		out = append(out, winInfo{
			Title:     title,
			X:         int(r.Left),
			Y:         int(r.Top),
			W:         int(r.Right - r.Left),
			H:         int(r.Bottom - r.Top),
			Minimized: ico != 0,
		})
		return 1
	})
	pEnumWindows.Call(cb, 0)
	return out
}

func findByTitle(title string) uintptr {
	lower := strings.ToLower(title)
	var found uintptr
	cb := syscall.NewCallback(func(h uintptr, l uintptr) uintptr {
		vis, _, _ := pIsWindowVisible.Call(h)
		if vis == 0 {
			return 1
		}
		buf := make([]uint16, 512)
		pGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		t := syscall.UTF16ToString(buf)
		if t != "" && strings.Contains(strings.ToLower(t), lower) {
			found = h
			return 0 // 停止枚举
		}
		return 1
	})
	pEnumWindows.Call(cb, 0)
	return found
}

// ---------------- 键鼠 ----------------

func clamp(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

var vkMap = map[string]byte{
	"backspace": 0x08, "tab": 0x09, "enter": 0x0D, "return": 0x0D, "shift": 0x10,
	"ctrl": 0x11, "control": 0x11, "alt": 0x12, "pause": 0x13, "capslock": 0x14,
	"esc": 0x1B, "escape": 0x1B, "space": 0x20, "pageup": 0x21, "pagedown": 0x22,
	"end": 0x23, "home": 0x24, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
	"printscreen": 0x2C, "insert": 0x2D, "delete": 0x2E, "del": 0x2E,
	"win": 0x5B, "lwin": 0x5B, "rwin": 0x5C, "apps": 0x5D,
	"numlock": 0x90, "scrolllock": 0x91,
	"f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
	"f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

func toVK(name string) byte {
	n := strings.ToLower(strings.TrimSpace(name))
	if v, ok := vkMap[n]; ok {
		return v
	}
	if len(n) == 1 {
		c := n[0]
		if c >= 'a' && c <= 'z' {
			return c - 32
		}
		if (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') {
			return c
		}
	}
	return 0
}

// ---------------- 剪贴板 ----------------

func setClipboard(text string) error {
	u, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}
	r, _, _ := pOpenClipboard.Call(0)
	if r == 0 {
		return fmt.Errorf("打开剪贴板失败")
	}
	defer pCloseClipboard.Call()
	pEmptyClipboard.Call()

	size := uintptr(len(u) * 2)
	h, _, _ := pGlobalAlloc.Call(gmemMoveable, size)
	if h == 0 {
		return fmt.Errorf("分配剪贴板内存失败")
	}
	ptr, _, _ := pGlobalLock.Call(h)
	if ptr == 0 {
		return fmt.Errorf("锁定剪贴板内存失败")
	}
	copy((*[1 << 20]uint16)(unsafe.Pointer(ptr))[:len(u):len(u)], u)
	pGlobalUnlock.Call(h)
	pSetClipboardData.Call(cfUnicodeText, h)
	return nil
}

func getClipboard() string {
	r, _, _ := pOpenClipboard.Call(0)
	if r == 0 {
		return ""
	}
	defer pCloseClipboard.Call()
	h, _, _ := pGetClipboardData.Call(cfUnicodeText)
	if h == 0 {
		return ""
	}
	ptr, _, _ := pGlobalLock.Call(h)
	if ptr == 0 {
		return ""
	}
	defer pGlobalUnlock.Call(h)
	sz, _, _ := pGlobalSize.Call(h)
	if sz < 2 {
		return ""
	}
	n := int(sz / 2)
	buf := (*[1 << 22]uint16)(unsafe.Pointer(ptr))[:n:n]
	return syscall.UTF16ToString(buf)
}

// ---------------- 动作 ----------------

func main() {
	pSetProcessDPIAware.Call() // 不设的话高 DPI 下截到的是放大后的模糊图

	if len(os.Args) < 2 {
		fail("用法: ctl.exe <动作> <参数JSON文件>")
	}
	action := strings.ToLower(os.Args[1])
	args = map[string]interface{}{}
	if len(os.Args) >= 3 && os.Args[2] != "" {
		if b, err := os.ReadFile(os.Args[2]); err == nil && len(b) > 0 {
			_ = json.Unmarshal(b, &args)
		}
	}

	vx, vy, vw, vh := virtualScreen()

	switch action {
	case "screen":
		data, w, h, scale, err := capture(argInt("maxWidth", 1600), argInt("quality", 62))
		if err != nil {
			fail(err.Error())
		}
		ok(map[string]interface{}{
			"base64":       base64.StdEncoding.EncodeToString(data),
			"mime":         "image/jpeg",
			"imageWidth":   w,
			"imageHeight":  h,
			"screenX":      vx,
			"screenY":      vy,
			"screenWidth":  vw,
			"screenHeight": vh,
			"scale":        scale,
			"foreground":   foregroundTitle(),
		})

	case "cursor":
		var p point
		pGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
		ok(map[string]interface{}{"x": p.X, "y": p.Y, "foreground": foregroundTitle()})

	case "windows":
		ws := listWindows()
		ok(map[string]interface{}{"count": len(ws), "windows": ws})

	case "focus":
		title := argStr("title", "")
		if title == "" {
			fail("缺少 title")
		}
		h := findByTitle(title)
		if h == 0 {
			fail("找不到标题包含「" + title + "」的窗口")
		}
		pShowWindow.Call(h, 9) // SW_RESTORE
		pSetForeground.Call(h)
		time.Sleep(250 * time.Millisecond)
		ok(map[string]interface{}{"foreground": foregroundTitle()})

	case "move":
		x := clamp(argInt("x", 0), vx, vx+vw-1)
		y := clamp(argInt("y", 0), vy, vy+vh-1)
		pSetCursorPos.Call(uintptr(x), uintptr(y))
		ok(map[string]interface{}{"x": x, "y": y})

	case "click":
		x, y := 0, 0
		if has("x") && has("y") {
			x = clamp(argInt("x", 0), vx, vx+vw-1)
			y = clamp(argInt("y", 0), vy, vy+vh-1)
			pSetCursorPos.Call(uintptr(x), uintptr(y))
			time.Sleep(60 * time.Millisecond)
		} else {
			var p point
			pGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
			x, y = int(p.X), int(p.Y)
		}

		var down, up uintptr
		switch strings.ToLower(argStr("button", "left")) {
		case "right":
			down, up = mouseRightDown, mouseRightUp
		case "middle":
			down, up = mouseMidDown, mouseMidUp
		default:
			down, up = mouseLeftDown, mouseLeftUp
		}
		times := 1
		if argBool("double", false) {
			times = 2
		}
		for i := 0; i < times; i++ {
			pMouseEvent.Call(down, 0, 0, 0, 0)
			time.Sleep(30 * time.Millisecond)
			pMouseEvent.Call(up, 0, 0, 0, 0)
			if times > 1 {
				time.Sleep(80 * time.Millisecond)
			}
		}
		ok(map[string]interface{}{"x": x, "y": y, "times": times})

	case "drag":
		x1 := clamp(argInt("x1", 0), vx, vx+vw-1)
		y1 := clamp(argInt("y1", 0), vy, vy+vh-1)
		x2 := clamp(argInt("x2", 0), vx, vx+vw-1)
		y2 := clamp(argInt("y2", 0), vy, vy+vh-1)

		pSetCursorPos.Call(uintptr(x1), uintptr(y1))
		time.Sleep(80 * time.Millisecond)
		pMouseEvent.Call(mouseLeftDown, 0, 0, 0, 0)
		time.Sleep(60 * time.Millisecond)
		// 分步移动：一步跳到终点，很多程序识别不出是拖拽
		const steps = 12
		for i := 1; i <= steps; i++ {
			nx := x1 + (x2-x1)*i/steps
			ny := y1 + (y2-y1)*i/steps
			pSetCursorPos.Call(uintptr(nx), uintptr(ny))
			time.Sleep(15 * time.Millisecond)
		}
		pMouseEvent.Call(mouseLeftUp, 0, 0, 0, 0)
		ok(map[string]interface{}{"fromX": x1, "fromY": y1, "toX": x2, "toY": y2})

	case "scroll":
		amount := argInt("amount", 3)
		pMouseEvent.Call(mouseWheel, 0, 0, uintptr(int32(amount*120)), 0)
		ok(map[string]interface{}{"amount": amount})

	case "type":
		text := argStr("text", "")
		if text == "" {
			fail("缺少 text")
		}
		// keybd_event 打不出中文，统一走剪贴板 + Ctrl+V
		old := getClipboard()
		if err := setClipboard(text); err != nil {
			fail(err.Error())
		}
		time.Sleep(60 * time.Millisecond)
		pKeybdEvent.Call(0x11, 0, 0, 0) // Ctrl down
		pKeybdEvent.Call(0x56, 0, 0, 0) // V down
		pKeybdEvent.Call(0x56, 0, keyup, 0)
		pKeybdEvent.Call(0x11, 0, keyup, 0)
		time.Sleep(120 * time.Millisecond)
		if old != "" {
			_ = setClipboard(old)
		}
		ok(map[string]interface{}{"length": len([]rune(text))})

	case "key":
		combo := argStr("keys", "")
		if combo == "" {
			fail("缺少 keys")
		}
		parts := strings.Split(combo, "+")
		var codes []byte
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			vk := toVK(p)
			if vk == 0 {
				fail("不认识的按键: " + p)
			}
			codes = append(codes, vk)
		}
		for _, c := range codes {
			pKeybdEvent.Call(uintptr(c), 0, 0, 0)
			time.Sleep(20 * time.Millisecond)
		}
		for i := len(codes) - 1; i >= 0; i-- {
			pKeybdEvent.Call(uintptr(codes[i]), 0, keyup, 0)
			time.Sleep(20 * time.Millisecond)
		}
		ok(map[string]interface{}{"keys": combo})

	case "launch":
		path := argStr("path", "")
		if path == "" {
			fail("缺少 path")
		}
		var c *exec.Cmd
		if a := argStr("args", ""); a != "" {
			c = exec.Command(path, a)
		} else {
			c = exec.Command(path)
		}
		c.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
		if err := c.Start(); err != nil {
			fail("启动失败: " + err.Error())
		}
		pid := c.Process.Pid
		_ = c.Process.Release()
		ok(map[string]interface{}{"path": path, "pid": pid})

	case "shell":
		command := argStr("command", "")
		if command == "" {
			fail("缺少 command")
		}
		cwd := argStr("cwd", "")
		timeoutMs := argInt("timeout", 30000)
		if timeoutMs > 120000 {
			timeoutMs = 120000
		}

		c := exec.Command("cmd.exe", "/d", "/s", "/c", command)
		if cwd != "" {
			c.Dir = cwd
		}
		var stdout, stderr bytes.Buffer
		c.Stdout = &stdout
		c.Stderr = &stderr
		c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

		if err := c.Start(); err != nil {
			fail("启动命令失败: " + err.Error())
		}

		done := make(chan error, 1)
		go func() { done <- c.Wait() }()

		select {
		case <-done:
		case <-time.After(time.Duration(timeoutMs) * time.Millisecond):
			if c.Process != nil {
				_ = c.Process.Kill()
			}
			fail(fmt.Sprintf("命令超时（%dms），已终止", timeoutMs))
		}

		out := truncate(stdout.String(), 4000)
		errOut := truncate(stderr.String(), 4000)
		exitCode := 0
		if c.ProcessState != nil {
			exitCode = c.ProcessState.ExitCode()
		}
		ok(map[string]interface{}{
			"exitCode": exitCode,
			"stdout":   out,
			"stderr":   errOut,
			"cwd":      cwd,
		})

	case "clipboard":
		ok(map[string]interface{}{"text": truncate(getClipboard(), 4000)})

	case "paths":
		// 方便调试：看看 ctl.exe 认为的屏幕和工作目录
		wd, _ := os.Getwd()
		self, _ := filepath.Abs(os.Args[0])
		ok(map[string]interface{}{
			"self": self, "cwd": wd,
			"screenX": vx, "screenY": vy, "screenWidth": vw, "screenHeight": vh,
		})

	default:
		fail("未知动作: " + action)
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "\n...[输出已截断]"
}
