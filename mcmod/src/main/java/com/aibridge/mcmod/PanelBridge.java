package com.aibridge.mcmod;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 面板和外面那个 Node 服务之间的桥。
 *
 * 面板跑在渲染线程上，绝不能在里面做网络请求（会卡帧）。
 * 所以状态由一个后台线程定时拉，UI 只读 volatile 字段；
 * 操作（停止循环）也丢到后台线程去发。
 */
final class PanelBridge {

    private static final String BASE = "http://127.0.0.1:8787";
    private static volatile String status = "正在读取…";
    private static volatile long lastFetch = 0;

    private PanelBridge() { }

    static String statusLine() {
        // 超过 5 秒没刷新就顺手触发一次（异步，不阻塞）
        if (System.currentTimeMillis() - lastFetch > 5000) refresh();
        return status;
    }

    /** 异步拉一次状态 */
    static void refresh() {
        lastFetch = System.currentTimeMillis();
        Thread t = new Thread(() -> {
            try {
                String json = get("/api/game/status");
                boolean running = json.contains("\"running\":true");
                String round = "0";
                int i = json.indexOf("\"round\":");
                if (i > 0) {
                    int j = i + 8;
                    StringBuilder sb = new StringBuilder();
                    while (j < json.length() && Character.isDigit(json.charAt(j))) sb.append(json.charAt(j++));
                    if (sb.length() > 0) round = sb.toString();
                }
                status = running ? ("AI 运行中 · 第 " + round + " 轮") : "AI 空闲";
            } catch (Throwable e) {
                status = "连不上 AIBridge 服务";
            }
        }, "aibridge-panel-refresh");
        t.setDaemon(true);
        t.start();
    }

    /** 异步停止循环 */
    static void stopLoop() {
        Thread t = new Thread(() -> {
            try {
                post("/api/game/stop", "{}");
                Thread.sleep(300);
                refresh();
            } catch (Throwable ignored) { }
        }, "aibridge-panel-stop");
        t.setDaemon(true);
        t.start();
        status = "已请求停止…";
    }

    private static String get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        c.setConnectTimeout(1500);
        c.setReadTimeout(1500);
        try (InputStream in = c.getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void post(String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        c.setConnectTimeout(1500);
        c.setReadTimeout(3000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
        c.getResponseCode();
    }
}
