package com.aibridge.mcmod;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Node 推给客户端渲染器的只读状态。
 *
 * 网络线程（HTTP）写、渲染线程读；用 volatile 快照整体替换，渲染侧不需要锁。
 * 所有坐标都是世界坐标，渲染时由 Minecraft 的相机矩阵处理。
 */
public final class VisualizationState {

    public static final class Snapshot {
        public final double[] path;       // 扁平 xyz 数组
        public final double tx, ty, tz;
        public final boolean hasTarget;
        public final String action;
        public final String status;
        public final double progress;
        public final boolean flow;
        public final boolean targetBox;
        public final boolean beam;
        public final boolean trail;
        public final boolean hud;

        Snapshot(double[] path, double tx, double ty, double tz, boolean hasTarget,
                 String action, String status, double progress,
                 boolean flow, boolean targetBox, boolean beam, boolean trail, boolean hud) {
            this.path = path;
            this.tx = tx; this.ty = ty; this.tz = tz;
            this.hasTarget = hasTarget;
            this.action = action;
            this.status = status;
            this.progress = progress;
            this.flow = flow;
            this.targetBox = targetBox;
            this.beam = beam;
            this.trail = trail;
            this.hud = hud;
        }
    }

    private static final Snapshot EMPTY = new Snapshot(
        new double[0], 0, 0, 0, false, "", "", 0,
        false, false, false, false, false);

    private static volatile Snapshot current = EMPTY;

    /** 历史轨迹：客户端 tick 追加，渲染线程只读拷贝。 */
    public static final List<double[]> trail = Collections.synchronizedList(new ArrayList<>());
    private static final int TRAIL_MAX = 120;

    private VisualizationState() {}

    public static Snapshot get() {
        return current;
    }

    public static void update(double[] path, double tx, double ty, double tz, boolean hasTarget,
                              String action, String status, double progress,
                              boolean flow, boolean targetBox, boolean beam, boolean trailOn, boolean hud) {
        current = new Snapshot(path, tx, ty, tz, hasTarget, action, status, progress,
            flow, targetBox, beam, trailOn, hud);
    }

    public static void pushTrail(double x, double y, double z) {
        trail.add(new double[] { x, y, z, System.currentTimeMillis() });
        while (trail.size() > TRAIL_MAX) trail.remove(0);
    }

    public static List<double[]> copyTrail() {
        synchronized (trail) {
            return new ArrayList<>(trail);
        }
    }
}
