package com.aibridge.mcmod;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;

/**
 * Fabric 版入口。
 *
 * 面板两种打开方式：
 *   - F8（GLFW 297；直接轮询物理按键，不依赖 MC 的点击计数）
 *   - 聊天里输入 /aibridge
 *
 * 两种方式都只「记一个待打开标记」，真正的切换放在下一 tick 做。
 * 原因：/aibridge 是在聊天界面里执行的，执行完 MC 会把聊天界面关掉（setScreen(null)），
 * 如果我们在命令里直接切屏，会先弹出面板再被那次关闭覆盖掉——表现就是「闪一下就没了」。
 */
public class AiBridgeMod implements ClientModInitializer {

    private static KeyMapping openPanel;
    private static boolean panelKeyWasDown = false;
    private static boolean tickLogged = false;
    private static volatile boolean pendingOpen = false;

    /** F8 = GLFW 297（F1 是 290，往后数：F8 = 290 + 7） */
    private static final int PANEL_KEY = 297;

    @Override
    public void onInitializeClient() {
        // 失焦自动暂停会把整个模拟冻住：AI 是通过 HTTP 控制的，窗口不在前台是常态。
        // 注意：onInitializeClient 时 Minecraft.options 还是 null，不能在这里设，
        // 真正的关闭放在第一个 client tick（那时 options 已加载）。

        try {
            ControlServer.start();
        } catch (Throwable t) {
            System.out.println("[AIBridge] 控制服务启动失败: " + t);
            t.printStackTrace();
        }

        try {
            VisualizationRenderer.register();
            System.out.println("[AIBridge] 可视化渲染已注册");
        } catch (Throwable t) {
            System.out.println("[AIBridge] 可视化注册失败: " + t);
            t.printStackTrace();
        }

        try {
            openPanel = KeyMappingHelper.registerKeyMapping(new KeyMapping(
                "key.aibridge.panel",
                PANEL_KEY,
                KeyMapping.Category.MISC
            ));
        } catch (Throwable t) {
            System.out.println("[AIBridge] 按键注册失败: " + t);
        }

        try {
            ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) ->
                dispatcher.register(ClientCommands.literal("aibridge").executes(ctx -> {
                    pendingOpen = true;   // 交给下一 tick，避开聊天界面关闭
                    return 1;
                }))
            );
            System.out.println("[AIBridge] 命令 /aibridge 已注册");
        } catch (Throwable t) {
            System.out.println("[AIBridge] 命令注册失败: " + t);
        }

        try {
            ClientTickEvents.END_CLIENT_TICK.register(client -> {
                if (!tickLogged) {
                    tickLogged = true;
                    // options 在构造期是 null，第一次 tick 才一定能拿到
                    try {
                        if (client.options != null) {
                            client.options.pauseOnLostFocus = false;
                            System.out.println("[AIBridge] 已关闭失焦自动暂停");
                        }
                    } catch (Throwable t) {
                        System.out.println("[AIBridge] 关闭失焦暂停失败: " + t);
                    }
                    System.out.println("[AIBridge] tick 钩子已生效，F8(297) 可开面板");
                }

                // 每帧续一下「按住右键」（拉弓/吃东西），不然蓄力会被 MC 刷掉
                ControlServer.tickUseHold(client);
                // 每帧续一下合成的移动输入（26.3 走路走的是 input.keyPresses，不是 KeyMapping）
                ControlServer.tickSynthInput(client);
                // 垫高：跳跃高度/落地判定必须按游戏 tick 推进
                ControlServer.tickPillar(client);

                boolean down = InputConstants.isKeyDown(PANEL_KEY);
                if (down && !panelKeyWasDown) {
                    System.out.println("[AIBridge] F8 按下");
                    pendingOpen = true;
                }
                panelKeyWasDown = down;

                if (pendingOpen) {
                    pendingOpen = false;
                    openPanelNow();
                }
            });
        } catch (Throwable t) {
            System.out.println("[AIBridge] tick 钩子注册失败: " + t);
        }
    }

    private static void openPanelNow() {
        Minecraft mc = Minecraft.getInstance();
        if (ControlServer.currentScreen() instanceof AiBridgeScreen) return;
        mc.setScreenAndShow(new AiBridgeScreen(ControlServer.currentScreen()));
        System.out.println("[AIBridge] 面板已打开");
    }
}
