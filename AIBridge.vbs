' AIBridge launcher
' Starts the local service (hidden) and opens it in an app-style window
' (no address bar, no tabs). Closing the window keeps the service running
' so the QQ bot stays online; use stop.bat to shut it down completely.

Option Explicit

Dim fso, sh, baseDir, nodeExe, appUrl, profileDir, logFile
Dim browser, runCmd, i, ready, desktopDir

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = baseDir
appUrl = "http://127.0.0.1:8787"

' ---------- locate node ----------
nodeExe = baseDir & "\runtime\node\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

' ---------- start service if needed ----------
If Not IsReady(appUrl) Then
  logFile = baseDir & "\data\logs\server.log"
  EnsureFolder fso.GetParentFolderName(logFile)

  runCmd = "cmd /c """"" & nodeExe & """ server.js >> """ & logFile & """ 2>&1"""
  sh.Run runCmd, 0, False

  ready = False
  For i = 1 To 60
    WScript.Sleep 500
    If IsReady(appUrl) Then
      ready = True
      Exit For
    End If
  Next
  If Not ready Then
    MsgBox "AIBridge service failed to start." & vbCrLf & vbCrLf & _
           "Log: " & logFile, 16, "AIBridge"
    WScript.Quit 1
  End If
End If

' ---------- open the window ----------
browser = FindBrowser(fso)
If browser = "" Then
  sh.Run appUrl, 1, False
  WScript.Quit 0
End If

profileDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\AIBridge\window"
EnsureFolder profileDir

runCmd = """" & browser & """" & _
         " --app=" & appUrl & _
         " --user-data-dir=""" & profileDir & """" & _
         " --window-size=1320,880" & _
         " --no-first-run --no-default-browser-check"
sh.Run runCmd, 1, False

' ---------- shortcuts (created once) ----------
desktopDir = sh.SpecialFolders("Desktop")
EnsureShortcut fso.BuildPath(baseDir, "AIBridge.lnk")
If desktopDir <> "" Then EnsureShortcut fso.BuildPath(desktopDir, "AIBridge.lnk")

' ---------- helpers ----------
Sub EnsureShortcut(lnkPath)
  Dim sc
  If fso.FileExists(lnkPath) Then Exit Sub
  On Error Resume Next
  Set sc = sh.CreateShortcut(lnkPath)
  sc.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
  sc.Arguments = """" & WScript.ScriptFullName & """"
  sc.WorkingDirectory = baseDir
  sc.IconLocation = baseDir & "\app.ico,0"
  sc.Description = "AIBridge - AI gateway"
  sc.WindowStyle = 1
  sc.Save
  Err.Clear
  On Error GoTo 0
End Sub
Function IsReady(url)
  Dim http, ok
  ok = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number = 0 Then
    http.setTimeouts 800, 800, 1500, 1500
    http.Open "GET", url & "/api/status", False
    http.Send
    If Err.Number = 0 Then
      If http.Status = 200 Then ok = True
    End If
  End If
  Err.Clear
  On Error GoTo 0
  IsReady = ok
End Function

Function FindBrowser(f)
  Dim list, p, i
  FindBrowser = ""
  list = Array( _
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", _
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
    "C:\Program Files\Google\Chrome\Application\chrome.exe", _
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" _
  )
  For i = 0 To UBound(list)
    p = list(i)
    If f.FileExists(p) Then
      FindBrowser = p
      Exit Function
    End If
  Next
End Function

Sub EnsureFolder(p)
  Dim f, parent
  If p = "" Then Exit Sub
  Set f = CreateObject("Scripting.FileSystemObject")
  If f.FolderExists(p) Then Exit Sub
  ' CreateFolder makes one level only, so create the parent chain first
  parent = f.GetParentFolderName(p)
  If parent <> "" Then
    If Not f.FolderExists(parent) Then EnsureFolder parent
  End If
  On Error Resume Next
  f.CreateFolder p
  Err.Clear
  On Error GoTo 0
End Sub
