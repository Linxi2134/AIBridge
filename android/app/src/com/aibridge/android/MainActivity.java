package com.aibridge.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** WebView 壳：启动本地 Node 网关，然后加载管理后台。 */
public class MainActivity extends Activity {
    private static final String HOST = "127.0.0.1";
    /** 首次启动要解压约 100MB 资源，冷启动时间明显长于后续启动。 */
    private static final int BOOT_TIMEOUT_MS = 60000;
    private static final int REQ_AUDIO = 41;
    private static final int REQ_FILE = 42;
    private static final int REQ_NOTIFY = 43;

    private WebView web;
    private WebView popup;
    private View splash;
    private TextView status;
    private Button retry;
    private ValueCallback<Uri[]> fileCallback;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private String baseUrl;
    private boolean booting;
    private boolean assetsPrepared;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        assetsPrepared = new java.io.File(getFilesDir(), "asset.stamp").isFile();

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0E14);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout splashBox = new LinearLayout(this);
        splashBox.setOrientation(LinearLayout.VERTICAL);
        splashBox.setGravity(Gravity.CENTER);
        splashBox.setBackgroundColor(0xFF0B0E14);
        status = new TextView(this);
        status.setText("正在启动 AIBridge…");
        status.setTextColor(0xFFE6EAF2);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        status.setPadding(48, 0, 48, 0);
        splashBox.addView(status);
        retry = new Button(this);
        retry.setText("重试");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startServerAndLoad();
            }
        });
        splashBox.addView(retry);
        splash = splashBox;
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setSupportMultipleWindows(true);
        s.setUserAgentString(s.getUserAgentString() + " AIBridgeAndroid/" + versionName(this));
        // 只允许 Debug 包远程调试：release 包开 WebView 调试等于把管理后台源码敞开。
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openUrl(request.getUrl());
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                // 首帧已经可以画了才收起启动图，避免白屏/半渲染。
                hideSplash();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
                view.evaluateJavascript(
                        "(function(){var r=document.querySelector('[data-route]');"
                                + "return (location.pathname||'')+' '+(r?r.getAttribute('data-route'):'')+' '"
                                + "+document.querySelectorAll('nav.nav-item').length;})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                NodeRuntime.logClient(MainActivity.this, "page " + value);
                            }
                        });
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                int code = error.getErrorCode();
                // 主动导航（比如重试）产生的 ABORTED/UNKNOWN 不当作故障。
                if (code != WebViewClient.ERROR_CONNECT
                        && code != WebViewClient.ERROR_TIMEOUT
                        && code != WebViewClient.ERROR_HOST_LOOKUP
                        && code != WebViewClient.ERROR_IO) {
                    return;
                }
                showError("无法连接本地网关（" + error.getDescription() + "）。\n"
                        + "网关可能还没启动完，稍后点“重试”。");
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean crashed = detail != null && detail.didCrash();
                NodeRuntime.logClient(MainActivity.this, "render process gone, crashed=" + crashed);
                // 返回 true 表示自己处理，否则整个应用会被系统杀掉。
                ui.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        showError(crashed ? "界面进程崩溃，正在重新加载…" : "界面进程被系统回收，正在重新加载…");
                        recreate();
                    }
                }, 300);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                NodeRuntime.logClient(MainActivity.this, "console: " + cm.message());
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 麦克风权限只有用户已经授过才放行，否则交给系统权限弹窗，别静默拒绝。
                boolean needsAudio = false;
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) needsAudio = true;
                }
                if (!needsAudio) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                    toast("请先允许麦克风权限，语音输入才能使用");
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                    return true;
                } catch (Throwable t) {
                    fileCallback = null;
                    return false;
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                // 前端 markdown 里的 target="_blank" 需要这里接管，否则点了没反应。
                final WebView child = new WebView(MainActivity.this);
                child.getSettings().setJavaScriptEnabled(false);
                child.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        boolean consumed = openUrl(request.getUrl());
                        // 在导航回调里直接 destroy 容易踩到 WebView 内部重入，延后一帧再销毁。
                        v.stopLoading();
                        ui.post(new Runnable() {
                            @Override
                            public void run() {
                                if (popup == child) popup = null;
                                child.destroy();
                            }
                        });
                        return consumed;
                    }
                });
                if (popup != null) popup.destroy();
                popup = child;
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(child);
                resultMsg.sendToTarget();
                return true;
            }
        });

        requestNotificationPermission();
        startServerAndLoad();
    }

    // ---- 启动流程 ----

    private void startServerAndLoad() {
        if (booting) return;
        booting = true;

        if (!assetsPrepared) {
            status.setText("首次启动：正在解压内置运行时（约 100MB），请稍候…");
        } else {
            status.setText("正在启动 AIBridge…");
        }
        status.setVisibility(View.VISIBLE);
        splash.setVisibility(View.VISIBLE);
        retry.setVisibility(View.GONE);
        web.setVisibility(View.GONE);

        try {
            startForegroundService(new Intent(this, ServerService.class));
        } catch (Throwable t) {
            booting = false;
            showError("无法启动后台服务：" + t.getMessage());
            return;
        }

        final boolean firstRun = !assetsPrepared;
        new Thread(new Runnable() {
            @Override
            public void run() {
                final int port = NodeRuntime.waitForPort(BOOT_TIMEOUT_MS);
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        booting = false;
                        if (port <= 0) {
                            showError(firstRun
                                    ? "首次启动超时：解压资源或启动网关失败。\n请查看 startup.log，或点“重试”。"
                                    : "网关启动超时（60 秒）。\n请查看 startup.log，或点“重试”。");
                            return;
                        }
                        assetsPrepared = true;
                        baseUrl = "http://" + HOST + ":" + port;
                        NodeRuntime.logClient(MainActivity.this, "gateway ready at " + baseUrl);
                        web.setVisibility(View.VISIBLE);
                        web.loadUrl(baseUrl + "/?android=1");
                    }
                });
            }
        }, "wait-node").start();
    }

    private void hideSplash() {
        splash.setVisibility(View.GONE);
    }

    private void showError(String text) {
        splash.setVisibility(View.VISIBLE);
        String detail = NodeRuntime.lastError();
        status.setText(detail == null ? text : text + "\n\n" + detail);
        status.setVisibility(View.VISIBLE);
        retry.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
        web.stopLoading();
    }

    /** @return true 表示已由外部应用接管。 */
    private boolean openUrl(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme();
        if ("about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)) return false;
        String host = uri.getHost();
        if (("http".equals(scheme) || "https".equals(scheme))
                && (HOST.equals(host) || "localhost".equals(host))) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Throwable t) {
            toast("没有可以打开该链接的应用");
        }
        return true;
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    /** 读安装包的 versionName，避免 UA 里的版本号和 version.json 漂移。 */
    private static String versionName(Activity activity) {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Throwable t) {
            return "1.0";
        }
    }

    // ---- 权限 ----

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            // 没有通知权限可要（或已经拿到）时，直接进入麦克风权限，两个弹窗别同时排。
            requestAudioPermission();
            return;
        }
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        } catch (Throwable ignored) {
            // 少数定制系统没有该权限常量对应实现
            requestAudioPermission();
        }
    }

    private void requestAudioPermission() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return;
        try {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_NOTIFY) {
            // 通知权限被拒不影响网关运行，只是前台服务通知不可见。
            if (!granted) toast("未授予通知权限：前台服务通知不可见，网关仍在后台运行");
            requestAudioPermission();
            return;
        }
        if (requestCode == REQ_AUDIO && !granted) {
            // 语音输入会一直失败，明确提示一次，避免用户以为界面坏了。
            toast("未授予麦克风权限：语音输入不可用，其余功能正常");
        }
    }

    // ---- 生命周期 ----

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (popup != null) {
            popup.destroy();
            popup = null;
        }
        if (web != null) {
            web.stopLoading();
            web.setWebChromeClient(null);
            web.setWebViewClient(null);
            web.destroy();
            web = null;
        }
        ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }
}
