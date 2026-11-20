package com.aibridge.mcmod;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.behavior.IPathingBehavior;
import baritone.api.pathing.calc.IPath;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalXZ;
import baritone.api.pathing.path.IPathExecutor;
import baritone.api.utils.BetterBlockPos;
import net.minecraft.core.BlockPos;

import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Baritone 全局寻路桥。
 *
 * 单独放一个类：没装 Baritone 时只有访问这个类才会触发 NoClassDefFoundError，
 * ControlServer 的 HTTP 处理会捕获并返回 available:false，AI 仍可退回本地 goto。
 */
public final class BaritonePathing {

    private BaritonePathing() {}

    /** 开始向 x/z（可选 y）寻路。y 为空时用 GoalXZ，只约束水平坐标。 */
    public static String gotoPath(double x, Double y, double z, int range) {
        IBaritone baritone = primary();
        if (baritone == null) return unavailable();

        Goal goal;
        if (y == null) {
            goal = new GoalXZ((int) Math.floor(x), (int) Math.floor(z));
        } else {
            BlockPos pos = BlockPos.containing(x, y, z);
            int r = Math.max(1, Math.min(8, range));
            goal = r > 0 ? new GoalNear(pos, r) : new GoalBlock(pos);
        }
        baritone.getCustomGoalProcess().setGoalAndPath(goal);
        return "{\"ok\":true,\"available\":true,\"goal\":\"" + esc(goal.toString()) + "\"}";
    }

    /** 停止 Baritone 当前所有进程，交还移动控制。 */
    public static String stop() {
        IBaritone baritone = primary();
        if (baritone == null) return unavailable();
        baritone.getPathingBehavior().cancelEverything();
        return "{\"ok\":true,\"available\":true}";
    }

    /** 当前路径/目标/预计 tick；path 给 Node 侧做可视化。 */
    public static String status() {
        IBaritone baritone = primary();
        if (baritone == null) return unavailable();

        IPathingBehavior pb = baritone.getPathingBehavior();
        boolean pathing = pb.isPathing();
        boolean hasPath = pb.hasPath();
        boolean calculating = pb.getInProgress().isPresent();
        Goal goal = pb.getGoal();
        Optional<Double> ticks = pb.estimatedTicksToGoal();

        StringBuilder sb = new StringBuilder(2048);
        sb.append("{\"ok\":true,\"available\":true")
          .append(",\"pathing\":").append(pathing)
          .append(",\"hasPath\":").append(hasPath)
          .append(",\"calculating\":").append(calculating);
        if (goal != null) sb.append(",\"goal\":\"").append(esc(goal.toString())).append('"');
        if (ticks != null && ticks.isPresent()) {
            sb.append(String.format(Locale.ROOT, ",\"ticks\":%.1f", ticks.get()));
        }

        IPathExecutor executor = pb.getCurrent();
        IPath path = executor == null ? null : executor.getPath();
        if (path == null) path = pb.getPath().orElse(null);
        if (path != null) {
            if (executor != null) sb.append(",\"position\":").append(executor.getPosition());
            sb.append(",\"path\":[");
            List<BetterBlockPos> points = path.positions();
            int n = 0;
            for (BetterBlockPos p : points) {
                if (n >= 128) break;
                if (n > 0) sb.append(',');
                sb.append('[').append(p.x).append(',').append(p.y).append(',').append(p.z).append(']');
                n++;
            }
            sb.append(']');
        }
        sb.append('}');
        return sb.toString();
    }

    private static IBaritone primary() {
        try {
            return BaritoneAPI.getProvider().getPrimaryBaritone();
        } catch (Throwable t) {
            return null;
        }
    }

    private static String unavailable() {
        return "{\"ok\":false,\"available\":false,\"error\":\"Baritone 未安装或未加载\"}";
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
