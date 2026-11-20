package com.aibridge.mcmod;

import java.lang.instrument.Instrumentation;

/**
 * Java agent entry point.
 *
 * Loaded via -javaagent before the game starts. Because 26.3 ships unobfuscated,
 * we can call the game API directly at runtime (classes resolve lazily), so no
 * Fabric, no Mixin, no bytecode manipulation is needed.
 */
public class AiBridgeAgent {

    public static void premain(String args, Instrumentation inst) {
        // 不要在这里直接起服务：premain 跑在游戏初始化之前，这时候碰任何 MC 的类
        // 都可能在它自己准备好之前把类加载进去，表现是游戏启动到一半直接崩（jvm.dll 里访问违例）。
        // 改成延迟几秒、在独立线程里起，等游戏自己的类加载和渲染线程都稳了再说。
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(5000);
            } catch (InterruptedException ignored) {
                return;
            }
            try {
                ControlServer.start();
            } catch (Throwable ex) {
                System.out.println("[AIBridge] failed to start control server: " + ex);
                ex.printStackTrace();
            }
        }, "aibridge-init");
        t.setDaemon(true);
        t.start();
    }
}
