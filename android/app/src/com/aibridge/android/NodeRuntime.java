package com.aibridge.android;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** 在应用私有目录里启动随包携带的 Node 运行时。 */
public final class NodeRuntime {
    /** server.js 的初始端口；WebView 的 localStorage 绑定在这个源上，必须保持稳定。 */
    public static final int PORT = 8787;
    /** server.js 遇到 EADDRINUSE 会顺延端口，等待启动时把这几个端口都探一遍。 */
    public static final int PORT_SPAN = 10;

    private static final String TAG = "AIBridgeNode";
    private static final Object LOCK = new Object();
    /** 超过该大小的 server.log 在启动前轮转一次，避免长期运行把存储写满。 */
    private static final long MAX_LOG_BYTES = 2L * 1024 * 1024;

    /** volatile：写线程持锁解压时，等待线程仍要能读到进程状态。 */
    private static volatile Process process;
    private static volatile boolean starting;
    /** 启动失败原因：waitForPort 据此立刻返回，不要让界面白等 60 秒超时。 */
    private static volatile String lastError;

    private NodeRuntime() {}

    /** 进程是否存活（不持锁，避免被解压流程阻塞）。 */
    public static boolean isRunning() {
        Process p = process;
        return p != null && p.isAlive();
    }

    /** 是否已经有启动流程在跑。 */
    public static boolean isStarting() {
        return starting;
    }

    public static String lastError() {
        return lastError;
    }

    public static void start(Context context) {
        synchronized (LOCK) {
            Process running = process;
            if (running != null && running.isAlive()) return;
            // 上一轮进程已经死了：清掉引用，别让 waitForPort 误判为“本轮启动失败”。
            process = null;

            starting = true;
            lastError = null;
            Context app = context.getApplicationContext();
            try {
                File root = app.getFilesDir();
                File appDir = new File(root, "nodejs-project");
                File libDir = new File(root, "lib");
                File caFile = new File(root, "ca/cert.pem");
                File stampFile = new File(root, "asset.stamp");

                String stamp = assetStamp(app);
                boolean prepared = stamp.equals(readText(stampFile))
                        && new File(appDir, "server.js").isFile()
                        && libDir.isDirectory();

                if (!prepared) {
                    // 解压约 100MB 资源很慢，必须用版本戳记录，否则每次启动都白拷一遍。
                    long t0 = System.currentTimeMillis();
                    debugLog(app, "unpack assets " + stamp);
                    copyAssetTree(app, "nodejs-project", appDir);
                    copyAssetTree(app, "libs", libDir);
                    copyAsset(app, "ca/cert.pem", caFile);
                    writeText(stampFile, stamp);
                    debugLog(app, "assets ready in " + (System.currentTimeMillis() - t0) + "ms");
                } else {
                    debugLog(app, "assets up to date");
                }

                File logFile = new File(root, "server.log");
                rotateLog(logFile);

                File node = new File(app.getApplicationInfo().nativeLibraryDir, "libnode_exec.so");
                if (!node.isFile()) {
                    throw new IOException("找不到 Node 运行时: " + node);
                }

                ProcessBuilder pb = new ProcessBuilder(node.getAbsolutePath(), "server.js");
                pb.directory(appDir);
                pb.redirectErrorStream(true);
                pb.environment().put("AIBRIDGE_ANDROID", "1");
                pb.environment().put("PORT", String.valueOf(PORT));
                pb.environment().put("HOME", root.getAbsolutePath());
                pb.environment().put("TMPDIR", app.getCacheDir().getAbsolutePath());
                pb.environment().put("SSL_CERT_FILE", caFile.getAbsolutePath());
                // Termux 版 Node 的 OpenSSL 默认去读 /data/data/com.termux/.../openssl.cnf，
                // 普通 Android 应用无权访问，直接指向 /dev/null，证书仍由 SSL_CERT_FILE 提供。
                pb.environment().put("OPENSSL_CONF", "/dev/null");
                pb.environment().put("LD_LIBRARY_PATH",
                        libDir.getAbsolutePath() + ":" + app.getApplicationInfo().nativeLibraryDir);
                pb.environment().put("NODE_PATH", new File(appDir, "node_modules").getAbsolutePath());
                pb.environment().put("NODE_OPTIONS", "--no-warnings");

                debugLog(app, "spawn " + node.getName() + " in " + appDir + " lib=" + libDir);
                process = pb.start();
                final Process p = process;

                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        pump(p, logFile);
                    }
                }, "node-log").start();
            } catch (Throwable t) {
                // 启动失败要让界面知道：状态写进服务器日志 + startup 日志，由 Activity 显示重试。
                Log.e(TAG, "start failed", t);
                lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
                debugLog(app, "start failed: " + t);
                writeLaunchError(app, t);
            } finally {
                starting = false;
            }
        }
    }

    /**
     * 等待网关就绪。
     *
     * @return 实际监听的端口；超时或进程提前退出时返回 -1。
     */
    public static int waitForPort(int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (lastError != null) return -1;
            Process p = process;
            if (p != null && !p.isAlive() && !starting) {
                debugLog(null, "node exited before listening");
                return -1;
            }
            for (int port = PORT; port < PORT + PORT_SPAN; port++) {
                if (isBridge(port)) return port;
            }
            try {
                Thread.sleep(400);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return -1;
            }
        }
        return -1;
    }

    public static void stop() {
        synchronized (LOCK) {
            Process p = process;
            process = null;
            if (p == null) return;
            try {
                p.destroy();
            } catch (Throwable ignored) {
                // 进程可能已退出
            }
        }
    }

    /** 把需要诊断的信息追加到外部目录的 startup.log（文件管理器可读）。 */
    public static void logClient(Context context, String message) {
        debugLog(context, "client: " + message);
    }

    // ---- 端口探测 ----

    private static boolean isBridge(int port) {
        if (!tcpOpen(port)) return false;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/status").openConnection();
            conn.setConnectTimeout(800);
            conn.setReadTimeout(800);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) return false;
            InputStream in = conn.getInputStream();
            String body = new String(readBytes(in, 2048), StandardCharsets.UTF_8);
            in.close();
            // 只认自家网关：/api/status 必带 ok:true；避免误连别的 http 服务。
            return body.contains("\"ok\":true");
        } catch (Throwable t) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static boolean tcpOpen(int port) {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 120);
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                // 关闭失败无所谓
            }
        }
    }

    private static byte[] readBytes(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[512];
        int n;
        while ((n = in.read(buf)) > 0 && out.size() < max) {
            out.write(buf, 0, Math.min(n, max - out.size()));
        }
        return out.toByteArray();
    }

    // ---- 日志 ----

    private static void pump(final Process p, final File logFile) {
        OutputStreamWriter log = null;
        try {
            log = new OutputStreamWriter(new FileOutputStream(logFile, true), StandardCharsets.UTF_8);
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                log.write(line);
                log.write('\n');
                log.flush();
            }
        } catch (Throwable t) {
            Log.e(TAG, "log pump stopped", t);
        } finally {
            if (log != null) {
                try {
                    log.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
            int code = -1;
            try {
                code = p.waitFor();
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            debugLog(null, "node exited code=" + code);
        }
    }

    private static void rotateLog(File log) {
        try {
            if (!log.isFile() || log.length() <= MAX_LOG_BYTES) return;
            File old = new File(log.getParentFile(), log.getName() + ".1");
            if (old.isFile() && !old.delete()) {
                Log.w(TAG, "无法删除旧日志 " + old);
            }
            if (!log.renameTo(old)) {
                // 重命名失败（被占用）时直接截断，保证不会无限增长。
                new FileOutputStream(log, false).close();
            }
        } catch (Throwable t) {
            Log.w(TAG, "日志轮转失败", t);
        }
    }

    private static void debugLog(Context context, String message) {
        Log.i(TAG, message);
        if (context == null) return;
        try {
            File dir = context.getExternalFilesDir(null);
            if (dir == null) return;
            if (!dir.exists() && !dir.mkdirs()) return;
            FileOutputStream out = new FileOutputStream(new File(dir, "startup.log"), true);
            try {
                OutputStreamWriter w = new OutputStreamWriter(out, StandardCharsets.UTF_8);
                w.write(String.format(java.util.Locale.US, "%tF %tT ", System.currentTimeMillis(), System.currentTimeMillis()));
                w.write(message);
                w.write('\n');
                w.flush();
            } finally {
                out.close();
            }
            File logFile = new File(dir, "startup.log");
            if (logFile.length() > MAX_LOG_BYTES) {
                File rotor = new File(dir, "startup.log.1");
                if (rotor.isFile() && !rotor.delete()) {
                    Log.w(TAG, "无法删除 " + rotor);
                }
                logFile.renameTo(rotor);
            }
        } catch (Throwable t) {
            Log.w(TAG, "startup.log 写入失败", t);
        }
    }

    private static void writeLaunchError(Context context, Throwable t) {
        try {
            File dir = context.getExternalFilesDir(null);
            if (dir == null) return;
            FileOutputStream out = new FileOutputStream(new File(dir, "startup-error.txt"), false);
            try {
                String text = "AIBridge 启动失败\n" + t.getClass().getName() + ": " + t.getMessage() + "\n";
                out.write(text.getBytes(StandardCharsets.UTF_8));
            } finally {
                out.close();
            }
        } catch (Throwable ignored) {
            // 外部存储不可用时放弃
        }
    }

    // ---- 资源解压 ----

    /** 版本戳：APK 升级（versionCode / versionName / 安装时间变化）后必须重新解压一次。 */
    private static String assetStamp(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            return info.versionName + "#" + info.versionCode + "#" + info.lastUpdateTime;
        } catch (Throwable t) {
            // 拿不到包信息就退化成固定值，至少不会每次启动都解压。
            return "unknown#0#0";
        }
    }

    private static String readText(File file) {
        if (!file.isFile()) return "";
        InputStream in = null;
        try {
            in = new FileInputStream(file);
            byte[] data = readBytes(in, 256);
            return new String(data, StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
    }

    private static void writeText(File file, String text) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录 " + parent);
        }
        FileOutputStream out = new FileOutputStream(file, false);
        try {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            out.close();
        }
    }

    private static void copyAsset(Context context, String assetPath, File dest) throws IOException {
        AssetManager am = context.getAssets();
        InputStream in = am.open(assetPath);
        try {
            File parent = dest.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IOException("无法创建目录 " + parent);
            }
            FileOutputStream out = new FileOutputStream(dest, false);
            try {
                byte[] buf = new byte[128 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    private static void copyAssetTree(Context context, String assetPath, File dest) throws IOException {
        AssetManager am = context.getAssets();
        String[] children = am.list(assetPath);
        if (children == null || children.length == 0) {
            copyAsset(context, assetPath, dest);
            return;
        }
        if (!dest.exists() && !dest.mkdirs()) throw new IOException("无法创建目录 " + dest);
        for (String child : children) {
            copyAssetTree(context, assetPath + "/" + child, new File(dest, child));
        }
    }
}
