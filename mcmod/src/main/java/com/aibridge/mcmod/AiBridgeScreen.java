package com.aibridge.mcmod;

import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * 游戏内的 AI 控制面板。
 *
 * 为什么要有：MC 窗口会锁鼠标，想看一眼 AI 状态 / 停掉它，得 alt-tab 到外面的窗口，
 * 鼠标就被系统抢来抢去。做成一个游戏内界面后：按 F8 → 鼠标被释放 → 点按钮 → 关掉继续玩。
 *
 * 布局放右上角、只有 150 宽，尽量少挡画面。
 * （26.3 的渲染 API 换成了 GuiGraphicsExtractor，做不了「背景透明的浮层」，
 *   只能是个标准界面，所以把它做小。）
 *
 * 只用按钮、不自己画字：按钮自带文字渲染最稳，状态那行用一个「禁用的按钮」当标签。
 */
public class AiBridgeScreen extends Screen {

    private final Screen parent;

    protected AiBridgeScreen(Screen parent) {
        super(Component.literal("AIBridge"));
        this.parent = parent;
    }

    @Override
    protected void init() {
        int w = 150;
        int x = this.width - w - 8;
        int y = 8;

        Button status = Button.builder(
            Component.literal(PanelBridge.statusLine()),
            b -> { }
        ).bounds(x, y, w, 20).build();
        status.active = false;
        addRenderableWidget(status);
        y += 24;

        addRenderableWidget(Button.builder(
            Component.literal("刷新"),
            b -> { PanelBridge.refresh(); rebuildWidgets(); }
        ).bounds(x, y, w, 20).build());
        y += 24;

        addRenderableWidget(Button.builder(
            Component.literal("停止 AI"),
            b -> { PanelBridge.stopLoop(); rebuildWidgets(); }
        ).bounds(x, y, w, 20).build());
        y += 24;

        addRenderableWidget(Button.builder(
            Component.literal("关闭"),
            b -> this.onClose()
        ).bounds(x, y, w, 20).build());
    }

    /**
     * 关掉时回到游戏。
     *
     * 不能用「还原父界面」——实测会跳到「按键设置」界面（父界面记录不准）。
     * 按玩家状态判断最稳：在世界里就回世界（null），在标题页才还原。
     */
    @Override
    public void onClose() {
        if (this.minecraft == null) return;
        if (this.minecraft.player != null) {
            this.minecraft.setScreenAndShow(null);
        } else {
            this.minecraft.setScreenAndShow(this.parent);
        }
    }

    /** 不暂停游戏：AI 该跑还得跑 */
    @Override
    public boolean isPauseScreen() {
        return false;
    }
}
