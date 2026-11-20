package com.aibridge.mcmod;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderContext;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.resources.Identifier;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Random;

/**
 * 纯客户端可视化：流光粒子、目标框、光柱、历史轨迹、HUD 状态。
 *
 * 数据从 VisualizationState 的 volatile 快照读；渲染/粒子都在客户端线程，
 * 不发包、不改世界状态。
 */
public final class VisualizationRenderer {

    private static final Random RNG = new Random();
    private static int tickCounter = 0;

    private VisualizationRenderer() {}

    public static void register() {
        ClientTickEvents.END_CLIENT_TICK.register(VisualizationRenderer::tick);
        LevelRenderEvents.AFTER_TRANSLUCENT_FEATURES.register(VisualizationRenderer::renderWorld);
        HudElementRegistry.addLast(
            Identifier.fromNamespaceAndPath("aibridge", "visualizer"),
            VisualizationRenderer::renderHud);
    }

    private static void tick(Minecraft mc) {
        VisualizationState.Snapshot s = VisualizationState.get();
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null) return;

        tickCounter++;
        if (s.trail && tickCounter % 10 == 0) {
            VisualizationState.pushTrail(p.getX(), p.getY(), p.getZ());
        }

        long now = System.currentTimeMillis();
        if (s.flow && s.path.length >= 6) {
            spawnFlow(mc, s, now);
        }
        if (s.beam && s.hasTarget) {
            // 目标上方光柱：从目标 y 往上 8 格循环
            double phase = (tickCounter % 80) / 10.0;
            mc.level.addParticle(ParticleTypes.END_ROD,
                s.tx + 0.5 + (RNG.nextDouble() - 0.5) * 0.15,
                s.ty + phase,
                s.tz + 0.5 + (RNG.nextDouble() - 0.5) * 0.15,
                0, 0.01, 0);
        }
    }

    private static void spawnFlow(Minecraft mc, VisualizationState.Snapshot s, long now) {
        int points = s.path.length / 3;
        if (points < 2) return;

        double total = 0;
        for (int i = 1; i < points; i++) {
            total += dist(s.path, i - 1, i);
        }
        if (total <= 1e-4) return;

        double phase = (now % 4000) / 4000.0;
        double want = phase * total;
        double acc = 0;
        for (int i = 1; i < points; i++) {
            double d = dist(s.path, i - 1, i);
            if (acc + d >= want) {
                double t = d <= 1e-6 ? 0 : (want - acc) / d;
                double x = lerp(s.path[(i - 1) * 3], s.path[i * 3], t);
                double y = lerp(s.path[(i - 1) * 3 + 1], s.path[i * 3 + 1], t);
                double z = lerp(s.path[(i - 1) * 3 + 2], s.path[i * 3 + 2], t);
                for (int n = 0; n < 2; n++) {
                    mc.level.addParticle(ParticleTypes.END_ROD,
                        x + (RNG.nextDouble() - 0.5) * 0.2,
                        y + 0.2 + (RNG.nextDouble() - 0.5) * 0.2,
                        z + (RNG.nextDouble() - 0.5) * 0.2,
                        0, 0.005, 0);
                }
                break;
            }
            acc += d;
        }
    }

    private static void renderWorld(LevelRenderContext ctx) {
        Minecraft mc = Minecraft.getInstance();
        VisualizationState.Snapshot s = VisualizationState.get();
        if (mc.level == null || mc.player == null) return;

        PoseStack pose = ctx.poseStack();
        // 26.3 的关卡渲染 pose 是相机相对的：世界坐标要先减去相机位置
        Vec3 cam = mc.gameRenderer.mainCamera().position();
        pose.pushPose();
        pose.translate(-cam.x, -cam.y, -cam.z);

        if (s.targetBox && s.hasTarget) {
            float pulse = 0.55f + 0.45f * (float) Math.sin(System.currentTimeMillis() / 260.0);
            int alpha = (int) (140 + 100 * pulse);
            AABB box = new AABB(s.tx, s.ty, s.tz, s.tx + 1, s.ty + 1, s.tz + 1).inflate(0.004);
            ctx.submitNodeCollector().submitCustomGeometry(pose, RenderTypes.linesTranslucent(),
                (p, vc) -> drawBox(vc, p, box, 80, 220, 255, alpha, 2.0f));
        }

        if (s.flow && s.path.length >= 6) {
            ctx.submitNodeCollector().submitCustomGeometry(pose, RenderTypes.linesTranslucent(),
                (p, vc) -> drawPath(vc, p, s.path, 70, 220, 255, 150));
        }

        if (s.trail) {
            List<double[]> tr = VisualizationState.copyTrail();
            long now = System.currentTimeMillis();
            ctx.submitNodeCollector().submitCustomGeometry(pose, RenderTypes.linesTranslucent(),
                (p, vc) -> drawTrail(vc, p, tr, now));
        }

        pose.popPose();
    }

    private static void drawBox(VertexConsumer vc, PoseStack.Pose p, AABB b,
                                int r, int g, int bl, int a, float width) {
        double x0 = b.minX, y0 = b.minY, z0 = b.minZ;
        double x1 = b.maxX, y1 = b.maxY, z1 = b.maxZ;
        // 12 条棱
        line(vc, p, x0, y0, z0, x1, y0, z0, r, g, bl, a, width);
        line(vc, p, x1, y0, z0, x1, y0, z1, r, g, bl, a, width);
        line(vc, p, x1, y0, z1, x0, y0, z1, r, g, bl, a, width);
        line(vc, p, x0, y0, z1, x0, y0, z0, r, g, bl, a, width);

        line(vc, p, x0, y1, z0, x1, y1, z0, r, g, bl, a, width);
        line(vc, p, x1, y1, z0, x1, y1, z1, r, g, bl, a, width);
        line(vc, p, x1, y1, z1, x0, y1, z1, r, g, bl, a, width);
        line(vc, p, x0, y1, z1, x0, y1, z0, r, g, bl, a, width);

        line(vc, p, x0, y0, z0, x0, y1, z0, r, g, bl, a, width);
        line(vc, p, x1, y0, z0, x1, y1, z0, r, g, bl, a, width);
        line(vc, p, x1, y0, z1, x1, y1, z1, r, g, bl, a, width);
        line(vc, p, x0, y0, z1, x0, y1, z1, r, g, bl, a, width);
    }

    private static void drawPath(VertexConsumer vc, PoseStack.Pose p, double[] path,
                                 int r, int g, int b, int a) {
        int n = path.length / 3;
        for (int i = 1; i < n; i++) {
            line(vc, p,
                path[(i - 1) * 3], path[(i - 1) * 3 + 1] + 0.15, path[(i - 1) * 3 + 2],
                path[i * 3], path[i * 3 + 1] + 0.15, path[i * 3 + 2],
                r, g, b, a, 2.0f);
        }
    }

    private static void drawTrail(VertexConsumer vc, PoseStack.Pose p, List<double[]> tr, long now) {
        double[] prev = null;
        for (double[] pt : tr) {
            long age = now - (long) pt[3];
            if (age > 60000) { prev = pt; continue; }
            if (prev != null) {
                int alpha = (int) (30 + 150 * (1.0 - age / 60000.0));
                // 越旧越紫：新=青紫，旧=深紫
                int r = (int) (120 + 60 * (1.0 - age / 60000.0));
                int g = (int) (80 + 40 * (1.0 - age / 60000.0));
                int b = 220;
                line(vc, p,
                    prev[0], prev[1] + 0.2, prev[2],
                    pt[0], pt[1] + 0.2, pt[2],
                    r, g, b, Math.max(10, alpha), 1.6f);
            }
            prev = pt;
        }
    }

    private static void line(VertexConsumer vc, PoseStack.Pose p,
                             double x1, double y1, double z1,
                             double x2, double y2, double z2,
                             int r, int g, int b, int a, float width) {
        vc.addVertex(p, (float) x1, (float) y1, (float) z1)
          .setColor(r, g, b, a).setNormal(p, 0, 1, 0).setLineWidth(width);
        vc.addVertex(p, (float) x2, (float) y2, (float) z2)
          .setColor(r, g, b, a).setNormal(p, 0, 1, 0).setLineWidth(width);
    }

    private static void renderHud(net.minecraft.client.gui.GuiGraphicsExtractor gui,
                                  net.minecraft.client.DeltaTracker delta) {
        Minecraft mc = Minecraft.getInstance();
        VisualizationState.Snapshot s = VisualizationState.get();
        if (mc.player == null) return;

        // 常驻小卡片：进世界就显示；没有任务时显示待命状态
        renderCard(gui, mc, s);

        if (!s.hud || !s.hasTarget) return;

        int w = gui.guiWidth();
        int h = gui.guiHeight();
        LocalPlayer p = mc.player;
        double dx = s.tx + 0.5 - p.getX();
        double dz = s.tz + 0.5 - p.getZ();
        double targetYaw = Math.toDegrees(Math.atan2(-dx, dz));
        double rel = targetYaw - p.getYRot();
        while (rel > 180) rel -= 360;
        while (rel < -180) rel += 360;

        if (Math.abs(rel) > 55) {
            double rad = Math.toRadians(rel);
            int radius = Math.min(w, h) / 3;
            int ax = (int) (w / 2.0 + Math.sin(rad) * radius);
            int ay = (int) (h / 2.0 - Math.cos(rad) * radius);
            gui.fill(ax - 5, ay - 5, ax + 5, ay + 5, 0xCC55DDFF);
            gui.fill(ax - 2, ay - 2, ax + 2, ay + 2, 0xFFFFFFFF);
        }
    }

    /**
     * 左上角常驻卡片：当前工作、动作、目标坐标/距离、任务进度。
     * 半透明深色底 + 青色边，尽量不挡视野。
     */
    private static void renderCard(net.minecraft.client.gui.GuiGraphicsExtractor gui,
                                   Minecraft mc, VisualizationState.Snapshot s) {
        int x = 10;
        int y = 10;
        int w = 176;
        int h = 58;

        gui.fill(x - 1, y - 1, x + w + 1, y + h + 1, 0x8055DDFF);
        gui.fill(x, y, x + w, y + h, 0xB810151A);
        gui.fill(x, y, x + 3, y + h, 0xFF55DDFF);

        String title = !s.action.isEmpty()
            ? "爱丽丝 · 自动游戏中"
            : (!s.status.isEmpty() ? "爱丽丝 · 工作中" : "爱丽丝 · 待命");
        gui.text(mc.font, title, x + 8, y + 6, 0xFF8FE8FF, false);

        if (!s.action.isEmpty()) {
            String tag = fit(mc.font, s.action, 72);
            int tagX = x + w - 8 - mc.font.width(tag);
            gui.text(mc.font, tag, tagX, y + 6, 0xFF6FA8B8, false);
        }

        String status = s.status.isEmpty() ? (s.action.isEmpty() ? "等待指令" : s.action) : s.status;
        gui.text(mc.font, fit(mc.font, status, w - 16), x + 8, y + 19, 0xFFF2F6F8, false);

        String target;
        if (s.hasTarget) {
            double dx = s.tx + 0.5 - mc.player.getX();
            double dy = s.ty + 0.5 - mc.player.getY();
            double dz = s.tz + 0.5 - mc.player.getZ();
            double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            target = String.format(java.util.Locale.ROOT,
                "目标 %d, %d, %d · %.1fm",
                Math.round(s.tx), Math.round(s.ty), Math.round(s.tz), dist);
        } else {
            target = "目标 —";
        }
        gui.text(mc.font, fit(mc.font, target, w - 16), x + 8, y + 31, 0xFFAAB8C2, false);

        int barX = x + 8;
        int barY = y + h - 9;
        int barW = w - 16;
        gui.fill(barX, barY, barX + barW, barY + 3, 0x66000000);
        int fillW = (int) (barW * Math.max(0, Math.min(1, s.progress)));
        if (fillW > 0) gui.fill(barX, barY, barX + fillW, barY + 3, 0xFF55DDFF);
    }

    /** 按像素宽度截断，超出加省略号；中文字体宽度不等宽，不能用字符数。 */
    private static String fit(net.minecraft.client.gui.Font font, String text, int maxWidth) {
        if (text == null || text.isEmpty() || font.width(text) <= maxWidth) return text;
        String ellipsis = "…";
        int cut = text.length();
        while (cut > 1 && font.width(text.substring(0, cut) + ellipsis) > maxWidth) {
            cut--;
        }
        return text.substring(0, cut) + ellipsis;
    }

    private static double dist(double[] path, int a, int b) {
        double dx = path[b * 3] - path[a * 3];
        double dy = path[b * 3 + 1] - path[a * 3 + 1];
        double dz = path[b * 3 + 2] - path[a * 3 + 2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static double lerp(double a, double b, double t) {
        return a + (b - a) * t;
    }
}
