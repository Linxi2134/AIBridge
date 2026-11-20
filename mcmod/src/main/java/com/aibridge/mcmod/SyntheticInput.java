package com.aibridge.mcmod;

/**
 * 进程内合成的按键状态。
 *
 * 26.3 的 KeyboardInput.tick() 每 tick 用 KeyMapping.isDown() 重建
 * LocalPlayer.input.keyPresses——也就是说，直接写 keyPresses 会在下一 tick
 * 被真实键盘状态覆盖，走路/跳跃其实一直是坏的（只是偶尔靠惯性看起来动了）。
 *
 * 唯一可靠的办法是在 isDown() 的返回值上叠加：KeyMappingMixin 只在标记
 * 生效期间把对应的 KeyMapping 报成按下，KeyboardInput 和 handleKeybinds
 * 读到的都是合成值，真实输入不受影响。
 */
public final class SyntheticInput {

    private static volatile long until = 0L;

    private static volatile boolean forward;
    private static volatile boolean backward;
    private static volatile boolean left;
    private static volatile boolean right;
    private static volatile boolean jump;
    private static volatile boolean shift;
    private static volatile boolean sprint;
    private static volatile boolean use;

    private SyntheticInput() {}

    /** 移动键组，ms 后自动失效（防止 handler 卡死把角色卡在一直走）。 */
    public static void setMovement(boolean f, boolean b, boolean l, boolean r,
                                   boolean j, boolean sh, boolean sp, long ms) {
        forward = f; backward = b; left = l; right = r;
        jump = j; shift = sh; sprint = sp;
        until = System.currentTimeMillis() + Math.max(50, ms);
    }

    /** 跳跃单独用：垫高时每个 tick 续一次，落地后清掉。 */
    public static void setJump(boolean down, long ms) {
        jump = down;
        until = System.currentTimeMillis() + Math.max(50, ms);
    }

    /** 右键按住（拉弓/吃东西）。 */
    public static void setUse(boolean down, long ms) {
        use = down;
        until = System.currentTimeMillis() + Math.max(50, ms);
    }

    public static boolean active() {
        return System.currentTimeMillis() < until;
    }

    public static boolean forward() { return forward; }
    public static boolean backward() { return backward; }
    public static boolean left() { return left; }
    public static boolean right() { return right; }
    public static boolean jump() { return jump; }
    public static boolean shift() { return shift; }
    public static boolean sprint() { return sprint; }
    public static boolean use() { return use; }

    public static void clearMovement() {
        forward = backward = left = right = jump = shift = sprint = false;
    }

    public static void clearUse() {
        use = false;
    }

    public static void clear() {
        clearMovement();
        clearUse();
        until = 0L;
    }
}
