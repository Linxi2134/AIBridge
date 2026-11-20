package com.aibridge.mcmod;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.gui.screens.worldselection.CreateWorldScreen;
import net.minecraft.client.gui.screens.worldselection.WorldCreationUiState;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.level.storage.LevelStorageSource;
import net.minecraft.world.level.storage.LevelSummary;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Local HTTP control surface.
 *
 * Everything that touches game state is marshalled onto the client thread via
 * Minecraft.execute(...) — reading or writing world state off-thread is unsafe.
 *
 * Because this runs inside the game process, no mouse or keyboard events are
 * generated at all: the user's cursor is never moved.
 *
 * Endpoints
 *   GET  /state                          player + world snapshot, plus "caps"
 *   GET  /blocks?r=4&filter=&limit=40    nearby non-air blocks
 *   POST /look   {yaw,pitch}             absolute rotation
 *   POST /move   {x,y,z}                 absolute position
 *   POST /key    {key,down}              hold/release movement keys
 *   POST /chat   {text}                  "/cmd" runs a command, otherwise chats
 *   POST /attack {}                      left click at the crosshair
 *   POST /use    {}                      right click at the crosshair
 *   POST /select {slot}                  hotbar slot 0-8
 */
public final class ControlServer {

    private static final int PORT = 8788;

    /** Bumped whenever endpoints are added, so the Node side can tell old jars apart. */
    private static final String API = "25";

    private static final String[] CAPS = {
        "state", "blocks", "look", "move", "key", "chat", "attack", "use", "select", "mine", "ui", "container", "slot", "gui", "click", "options", "servers", "craft", "take", "frame", "pillar", "trades", "resume", "interact", "glide", "hit", "bridge", "place", "stop", "visualize", "besttool", "bestweapon", "bestarmor", "baritone", "worlds", "world", "gamerule"
    };

    private static HttpServer server;

    private ControlServer() {}

    public static synchronized void start() throws IOException {
        if (server != null) return;

        server = HttpServer.create(new InetSocketAddress("127.0.0.1", PORT), 0);
        server.createContext("/state", ControlServer::handleState);
        server.createContext("/blocks", ControlServer::handleBlocks);
        server.createContext("/look", ControlServer::handleLook);
        server.createContext("/move", ControlServer::handleMove);
        server.createContext("/key", ControlServer::handleKey);
        server.createContext("/usehold", ControlServer::handleUseHold);
        server.createContext("/keyhold", ControlServer::handleKeyHold);
        server.createContext("/inputdebug", ControlServer::handleInputDebug);
        server.createContext("/chat", ControlServer::handleChat);
        server.createContext("/attack", ControlServer::handleAttack);
        server.createContext("/mine", ControlServer::handleMine);
        server.createContext("/use", ControlServer::handleUse);
        server.createContext("/select", ControlServer::handleSelect);
        server.createContext("/ui", ControlServer::handleUi);
        server.createContext("/container", ControlServer::handleContainer);
        server.createContext("/slot", ControlServer::handleSlot);
        server.createContext("/gui", ControlServer::handleGui);
        server.createContext("/world/list", ControlServer::handleWorldList);
        server.createContext("/world/play", ControlServer::handleWorldPlay);
        server.createContext("/world/create", ControlServer::handleWorldCreate);
        server.createContext("/world/quit", ControlServer::handleWorldQuit);
        server.createContext("/gamerule", ControlServer::handleGameRule);
        server.createContext("/click", ControlServer::handleClick);
        server.createContext("/options", ControlServer::handleOptions);
        server.createContext("/servers", ControlServer::handleServers);
        server.createContext("/craft", ControlServer::handleCraft);
        server.createContext("/take", ControlServer::handleTake);
        server.createContext("/frame", ControlServer::handleFrame);
        server.createContext("/pillar", ControlServer::handlePillar);
        server.createContext("/trades", ControlServer::handleTrades);
        server.createContext("/resume", ControlServer::handleResume);
        server.createContext("/interact", ControlServer::handleInteract);
        server.createContext("/glide", ControlServer::handleGlide);
        server.createContext("/hit", ControlServer::handleHit);
        server.createContext("/bridge", ControlServer::handleBridge);
        server.createContext("/place", ControlServer::handlePlace);
        server.createContext("/stop", ControlServer::handleStop);
        server.createContext("/visualize", ControlServer::handleVisualize);
        server.createContext("/besttool", ControlServer::handleBestTool);
        server.createContext("/bestweapon", ControlServer::handleBestWeapon);
        server.createContext("/bestarmor", ControlServer::handleBestArmor);
        server.createContext("/baritone/goto", ControlServer::handleBaritoneGoto);
        server.createContext("/baritone/status", ControlServer::handleBaritoneStatus);
        server.createContext("/baritone/stop", ControlServer::handleBaritoneStop);
        // 挖方块要阻塞 1~2 秒，单线程 dispatcher 会把 /state 一起堵死
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
        server.start();

        System.out.println("[AIBridge] control server listening on 127.0.0.1:" + PORT + " (api " + API + ")");
    }

    // ---------------- handlers ----------------

    private static void handleState(HttpExchange ex) throws IOException {
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            ClientLevel level = mc.level;
            if (p == null || level == null) {
                return "{\"ok\":true,\"api\":\"" + API + "\",\"inWorld\":false,\"caps\":" + capsJson() + "}";
            }

            StringBuilder sb = new StringBuilder(512);
            sb.append("{\"ok\":true,\"api\":\"").append(API).append('"');
            sb.append(",\"inWorld\":true");
            sb.append(",\"caps\":").append(capsJson());
            sb.append(String.format(",\"x\":%.3f,\"y\":%.3f,\"z\":%.3f", p.getX(), p.getY(), p.getZ()));
            sb.append(String.format(",\"yaw\":%.2f,\"pitch\":%.2f", p.getYRot(), p.getXRot()));
            sb.append(",\"facing\":\"").append(p.getDirection().getName()).append('"');
            sb.append(String.format(",\"health\":%.1f,\"food\":%d", p.getHealth(), p.getFoodData().getFoodLevel()));
            sb.append(",\"onGround\":").append(p.onGround());
            sb.append(String.format(",\"fallDistance\":%.2f", p.fallDistance));
            sb.append(",\"dimension\":\"").append(dimensionId(level)).append('"');
            try {
                net.minecraft.client.server.IntegratedServer srv = mc.getSingleplayerServer();
                if (srv != null) {
                    sb.append(",\"allowCommands\":").append(srv.getWorldData().isAllowCommands());
                    sb.append(",\"keepInventory\":").append(srv.getGameRules().get(GameRules.KEEP_INVENTORY));
                }
            } catch (Throwable ignore) {}

            BlockPos feet = BlockPos.containing(p.getX(), p.getY() + 0.1, p.getZ());
            sb.append(",\"feet\":\"").append(blockId(level, feet)).append('"');
            sb.append(",\"below\":\"").append(blockId(level, feet.below())).append('"');
            sb.append(",\"head\":\"").append(blockId(level, feet.above())).append('"');

            sb.append(",\"target\":").append(targetJson(mc));
            sb.append(",\"hand\":").append(handJson(p));
            // 四件护甲 + 副手：被动防御要判断该不该换甲/有没有盾
            sb.append(",\"helmet\":\"").append(armorId(p, 3)).append('"');
            sb.append(",\"chest\":\"").append(armorId(p, 2)).append('"');
            sb.append(",\"leggings\":\"").append(armorId(p, 1)).append('"');
            sb.append(",\"boots\":\"").append(armorId(p, 0)).append('"');
            sb.append(",\"armor\":").append(armorJson(p));
            sb.append(",\"offhand\":\"").append(itemId(p.getOffhandItem())).append('"');
            sb.append(",\"blocking\":").append(p.isBlocking());
            // 谁打的我：反击不再只靠“附近有敌对生物”，远程怪也能锁定
            net.minecraft.world.entity.LivingEntity attacker = p.getLastHurtByMob();
            sb.append(",\"lastAttacker\":");
            if (attacker != null && attacker.isAlive()) {
                sb.append("{\"type\":\"").append(entityId(attacker)).append('"')
                  .append(",\"eid\":").append(attacker.getId())
                  .append(String.format(",\"dist\":%.1f", attacker.distanceTo(p)))
                  .append(String.format(",\"hp\":%.1f}", attacker.getHealth()));
            } else {
                sb.append("null");
            }
            sb.append(",\"hotbar\":").append(hotbarJson(p));
            sb.append(",\"inv\":").append(invJson(p));
            sb.append(",\"invItems\":").append(invItemsJson(p));
            sb.append(",\"entities\":").append(entitiesJson(level, p));
            sb.append(",\"screen\":\"").append(uiName()).append('"');
            // 拉弓状态：wasUsing 只能证明「这一帧还在用」，没法证明蓄了多久。
            // chargedTicks 是 MC 自己累计的（总时长 - 剩余），弓箭蓄力判断靠它。
            boolean using = p.isUsingItem();
            sb.append(",\"using\":").append(using);
            if (using) {
                int remaining = p.getUseItemRemainingTicks();
                int total = Math.max(1, p.getUseItem().getUseDuration(p));
                sb.append(",\"useRemaining\":").append(remaining);
                sb.append(",\"useChargeMs\":").append(Math.max(0, total - remaining) * 50L);
            } else {
                sb.append(",\"useRemaining\":0,\"useChargeMs\":0");
            }
            sb.append(",\"flying\":").append(p.isFallFlying());
            sb.append(",\"paused\":").append(mc.isPaused());
            // 背包空槽：模型/反射层判断「该去存东西了」用。
            // 只数主背包+快捷栏 36 格，护甲/副手不算。
            int emptySlots = 0;
            for (int i = 0; i < 36; i++) {
                if (p.getInventory().getItem(i).isEmpty()) emptySlots++;
            }
            sb.append(",\"emptySlots\":").append(emptySlots);
            sb.append(",\"sleeping\":").append(p.isSleeping());
            // 26.3 用 world clock；getDefaultClockTime 就是当前维度的一天内时间
            sb.append(",\"dayTime\":").append(mc.level.getDefaultClockTime() % 24000L);

            // 危险感知：正前方方块 + 前方落差（悬崖）、头顶松软方块、氧气、手持耐久
            Direction facing = p.getDirection();
            BlockPos front = BlockPos.containing(
                p.getX() + facing.getStepX() * 1.2,
                p.getY() + 0.1,
                p.getZ() + facing.getStepZ() * 1.2);
            sb.append(",\"front\":\"").append(blockId(level, front)).append('"');
            int drop = 5;
            for (int d = 1; d <= 5; d++) {
                if (!level.getBlockState(front.below(d)).isAir()) { drop = d - 1; break; }
            }
            sb.append(",\"frontDrop\":").append(drop);

            int unstable = 0;
            BlockPos basePos = BlockPos.containing(p.getX(), p.getY(), p.getZ());
            for (int dx = -1; dx <= 1; dx++) {
                for (int dz = -1; dz <= 1; dz++) {
                    for (int dy = 1; dy <= 3; dy++) {
                        String bid = blockId(level, basePos.offset(dx, dy, dz));
                        if (bid.contains("sand") || bid.contains("gravel")) unstable++;
                    }
                }
            }
            sb.append(",\"unstableAbove\":").append(unstable);
            sb.append(",\"air\":").append(p.getAirSupply());
            sb.append(",\"maxAir\":").append(p.getMaxAirSupply());

            ItemStack handItem = p.getMainHandItem();
            sb.append(",\"handDamage\":").append(handItem.getDamageValue());
            sb.append(",\"handMaxDamage\":").append(handItem.getMaxDamage());
            sb.append(",\"dead\":").append(p.getHealth() <= 0.0f);
            sb.append('}');
            return sb.toString();
        });
        respond(ex, body);
    }

    private static void handleBlocks(HttpExchange ex) throws IOException {
        Map<String, String> q = query(ex.getRequestURI().getRawQuery());
        int r = clampInt(q.get("r"), 4, 1, 8);
        int limit = clampInt(q.get("limit"), 40, 1, 200);
        String filter = q.get("filter") == null ? "" : q.get("filter").toLowerCase();

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            ClientLevel level = mc.level;
            if (p == null || level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            BlockPos origin = BlockPos.containing(p.getX(), p.getY(), p.getZ());
            Map<String, Integer> counts = new LinkedHashMap<>();
            List<Object[]> found = new ArrayList<>();

            for (int dx = -r; dx <= r; dx++) {
                for (int dy = -r; dy <= r; dy++) {
                    for (int dz = -r; dz <= r; dz++) {
                        BlockPos pos = origin.offset(dx, dy, dz);
                        BlockState st = level.getBlockState(pos);
                        if (st.isAir()) continue;
                        String id = BuiltInRegistries.BLOCK.getKey(st.getBlock()).toString();
                        if (!filter.isEmpty() && !id.contains(filter)) continue;
                        counts.merge(id, 1, Integer::sum);
                        found.add(new Object[] { dx, dy, dz, id });
                    }
                }
            }

            found.sort((a, b) -> dist2(a) - dist2(b));

            StringBuilder sb = new StringBuilder(512);
            sb.append("{\"ok\":true,\"origin\":{\"x\":").append(origin.getX())
              .append(",\"y\":").append(origin.getY())
              .append(",\"z\":").append(origin.getZ()).append('}');
            sb.append(",\"radius\":").append(r);

            sb.append(",\"counts\":{");
            List<Map.Entry<String, Integer>> sorted = new ArrayList<>(counts.entrySet());
            sorted.sort((a, b) -> b.getValue() - a.getValue());
            int n = 0;
            for (Map.Entry<String, Integer> e : sorted) {
                if (n >= 14) break;
                if (n > 0) sb.append(',');
                sb.append('"').append(escape(e.getKey())).append("\":").append(e.getValue());
                n++;
            }
            sb.append('}');

            sb.append(",\"near\":[");
            for (int i = 0; i < Math.min(limit, found.size()); i++) {
                Object[] o = found.get(i);
                if (i > 0) sb.append(',');
                sb.append("{\"dx\":").append(o[0])
                  .append(",\"dy\":").append(o[1])
                  .append(",\"dz\":").append(o[2])
                  .append(",\"id\":\"").append(escape((String) o[3])).append("\"}");
            }
            sb.append("],\"total\":").append(found.size()).append('}');
            return sb.toString();
        });
        respond(ex, body);
    }

    private static void handleLook(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double yaw = num(raw, "yaw");
        Double pitch = num(raw, "pitch");
        if (yaw == null && pitch == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need yaw or pitch\"}");
            return;
        }

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            float y = yaw != null ? yaw.floatValue() : p.getYRot();
            float pt = pitch != null ? pitch.floatValue() : p.getXRot();
            p.setYRot(y);
            p.setXRot(pt);
            return String.format("{\"ok\":true,\"yaw\":%.2f,\"pitch\":%.2f}", y, pt);
        });
        respond(ex, body);
    }

    private static void handleMove(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double x = num(raw, "x");
        Double y = num(raw, "y");
        Double z = num(raw, "z");
        if (x == null || y == null || z == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need x,y,z\"}");
            return;
        }

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            p.setPos(x, y, z);
            p.setDeltaMovement(0, 0, 0);
            // 瞬移之后必须把「在地面上」清掉，否则玩家会悬在半空不掉下来
            // （实测 y=78 脚下是空气却一直浮着，往下挖永远挖不动）
            p.setOnGround(false);
            return String.format("{\"ok\":true,\"x\":%.3f,\"y\":%.3f,\"z\":%.3f}", x, y, z);
        });
        respond(ex, body);
    }

    /**
     * 按住右键用物品（拉弓、吃东西、举盾）。
     *
     * 26.3 的 Minecraft.handleKeybinds() 每帧检查 options.keyUse.isDown()，
     * 一松开就 releaseUsingItem()；KeyMapping.setAll() 又会用真实输入覆盖
     * setDown() 的结果。所以纯 Java 层怎么模拟都撑不过一帧。
     *
     * 现在由 SyntheticInput + KeyMappingMixin 让 isDown() 在按住期间恒为 true，
     * 蓄力交给 MC 自己的 tick 累积（useItemRemaining 每 tick 减 1），
     * 到时间再调 gameMode.releaseUsingItem() —— 它会发 RELEASE_USE_ITEM 并
     * 触发弓箭的 releaseUsing，箭才真正射出去。
     */
    private static void handleUseHold(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double msNum = num(raw, "ms");
        final int ms = Math.max(100, Math.min(5000, msNum == null ? 1000 : msNum.intValue()));

        String startJson = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            ItemStack held = p.getMainHandItem();
            useHoldUntil = System.currentTimeMillis() + ms;
            useHoldActive = true;
            SyntheticInput.setUse(true, ms + 2000);

            // useItem 会走 ItemStack.use（弓箭在这里 startUsingItem）并发
            // ServerboundUseItemPacket；只调 startUsingItem 服务端不知道玩家在用，
            // 最后的 RELEASE_USE_ITEM 会被当成无效包丢掉。
            if (mc.gameMode != null) mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);

            boolean using = p.isUsingItem();
            if (!using) {
                // 没有箭的弓、瞬间完成的物品：别让合成右键一直挂在下一次 tick 上。
                useHoldActive = false;
                SyntheticInput.clearUse();
            }
            return "{\"ok\":true,\"item\":\"" + itemId(held) + "\",\"using\":" + using + "}";
        });

        if (!startJson.contains("\"ok\":true")) {
            useHoldActive = false;
            SyntheticInput.clearUse();
            respond(ex, startJson);
            return;
        }

        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }

        String endJson = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) {
                useHoldActive = false;
                SyntheticInput.clearUse();
                return "{\"ok\":false,\"error\":\"not in world\"}";
            }

            boolean wasUsing = p.isUsingItem();
            int left = wasUsing ? p.getUseItemRemainingTicks() : 0;
            int total = wasUsing ? Math.max(1, p.getUseItem().getUseDuration(p)) : 0;
            int charged = wasUsing ? Math.max(0, total - left) : 0;

            useHoldActive = false;
            SyntheticInput.clearUse();
            if (wasUsing && mc.gameMode != null) {
                mc.gameMode.releaseUsingItem(p);
            }
            return "{\"ok\":true,\"wasUsing\":" + wasUsing
                + ",\"remaining\":" + left + ",\"chargedTicks\":" + charged + "}";
        });

        respond(ex, endJson);
    }

    /** 由 tick 钩子每帧调用：维持合成的移动输入 */
    static void tickSynthInput(Minecraft mc) {
        if (!synthActive) return;
        LocalPlayer p = mc.player;
        if (p == null || p.input == null) { synthActive = false; return; }

        if (System.currentTimeMillis() >= synthUntil) {
            p.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
            synthActive = false;
            SyntheticInput.clearMovement();
            return;
        }
        p.input.keyPresses = new net.minecraft.world.entity.player.Input(
            sF, sB, sL, sR, sJ, sShift, sSprint);
    }

    static void tickUseHold(Minecraft mc) {
        if (!useHoldActive) return;
        LocalPlayer p = mc.player;
        if (p == null) {
            useHoldActive = false;
            SyntheticInput.clearUse();
            return;
        }

        if (System.currentTimeMillis() >= useHoldUntil) return;   // 时间到，等 handler 收尾

        // keyUse.isDown() 由 Mixin 恒定返回 true，正常情况这里什么都不用做。
        // 但切物品 / 被攻击 / 服务端拒绝会打断使用状态，这时重新开始一次：
        // 蓄力会从头算，但总比整段静默失败强（调用方会从 chargedTicks 看出来）。
        if (!p.isUsingItem()) {
            ItemStack held = p.getMainHandItem();
            if (!held.isEmpty() && held.getUseDuration(p) > 0 && mc.gameMode != null) {
                mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);
            }
        }
    }

    /**
     * 按住一组移动键走一段时间（合成输入）。
     *
     * keys 用 + 连接，支持 w/s/a/d/jump/sprint/sneak。
     * 例：{"keys":"w","ms":800}  {"keys":"w+jump","ms":400}
     */
    private static void handleKeyHold(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String keys = str(raw, "keys");
        Double msNum = num(raw, "ms");
        final int ms = Math.max(50, Math.min(5000, msNum == null ? 300 : msNum.intValue()));
        if (keys == null || keys.isEmpty()) {
            respond(ex, "{\"ok\":false,\"error\":\"need keys\"}");
            return;
        }

        String k = keys.toLowerCase();
        sF = k.contains("w");
        sB = k.contains("s");
        sL = k.contains("a");
        sR = k.contains("d");
        sJ = k.contains("jump") || k.contains("space");
        sShift = k.contains("sneak") || k.contains("shift");
        sSprint = k.contains("sprint");

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || p.input == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            synthUntil = System.currentTimeMillis() + ms;
            synthActive = true;
            // 两条都要：isDown 供 KeyboardInput.tick 重建 keyPresses，
            // 直接写 keyPresses 让当前 tick 立刻生效。
            SyntheticInput.setMovement(sF, sB, sL, sR, sJ, sShift, sSprint, ms + 200);
            p.input.keyPresses = new net.minecraft.world.entity.player.Input(
                sF, sB, sL, sR, sJ, sShift, sSprint);
            return "{\"ok\":true}";
        });

        if (!body.contains("\"ok\":true")) { respond(ex, body); return; }

        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }

        String end = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p != null && p.input != null) p.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
            synthActive = false;
            SyntheticInput.clearMovement();
            return "{\"ok\":true,\"ms\":" + ms + "}";
        });
        respond(ex, end);
    }

    /**
     * 原地垫高（pillar up）。
     *
     * 竖井、悬崖、树顶都上不去，goto 只会在平面上绕。这里把「跳起来、在脚下
     * 放一块方块、落到新方块上」做成确定性循环，每格只依赖一次跳跃的时序。
     *
     * 时序放在 tick 钩子里而不是 handler 的 sleep：跳跃高度、落地判定都必须
     * 按游戏 tick 读，HTTP 线程的墙钟时间和游戏帧对不上（尤其掉帧时）。
     */
    private static void handlePillar(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double countNum = num(raw, "count");
        final int count = Math.max(1, Math.min(16, countNum == null ? 1 : countNum.intValue()));

        CompletableFuture<String> done = new CompletableFuture<>();
        String start = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            if (!p.onGround()) return "{\"ok\":false,\"error\":\"pillar 需要先站在地面上\"}";

            int slot = findPlaceableSlot(p);
            if (slot < 0) return "{\"ok\":false,\"error\":\"快捷栏里没有可放置的方块\"}";
            p.getInventory().setSelectedSlot(slot);

            pillarTarget = count;
            pillarPlaced = 0;
            pillarPhase = 0;
            pillarStartY = p.getY();
            pillarDeadline = System.currentTimeMillis() + count * 4000L + 5000L;
            pillarFuture = done;
            pillarActive = true;
            return "{\"ok\":true,\"slot\":" + slot + "}";
        });

        if (!start.contains("\"ok\":true")) {
            respond(ex, start);
            return;
        }

        try {
            respond(ex, done.get(90, TimeUnit.SECONDS));
        } catch (Exception e) {
            pillarActive = false;
            respond(ex, "{\"ok\":false,\"error\":\"pillar 超时\"}");
        }
    }

    private static int findPlaceableSlot(LocalPlayer p) {
        return findPlaceableSlot(p, "");
    }

    private static int findPlaceableSlot(LocalPlayer p, String want) {
        String w = want == null ? "" : want.replace("minecraft:", "").toLowerCase();
        for (int i = 0; i < 9; i++) {
            ItemStack st = p.getInventory().getItem(i);
            if (st.isEmpty() || !(st.getItem() instanceof net.minecraft.world.item.BlockItem)) continue;
            if (w.isEmpty() || itemId(st).toLowerCase().contains(w)) return i;
        }
        return -1;
    }

    /** 由 tick 钩子每帧推进垫高状态机。 */
    static void tickPillar(Minecraft mc) {
        if (!pillarActive) return;
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null) { pillarFinish(false, "not in world"); return; }
        if (System.currentTimeMillis() > pillarDeadline) { pillarFinish(false, "超时（头顶被挡？）"); return; }

        if (pillarPhase == 0) {
            pillarStartY = p.getY();
            // 起跳：KeyboardInput 每 tick 从 KeyMapping 重建输入，必须走合成层
            SyntheticInput.setJump(true, 300);
            pillarPhase = 1;
            return;
        }

        if (pillarPhase == 1) {
            // 跳起来后继续按住，直到离地；到接近最高点再放，避免刚起跳就被自己挡住
            SyntheticInput.setJump(true, 300);
            double rise = p.getY() - pillarStartY;
            if (rise >= 1.02 && p.getDeltaMovement().y <= 0.08) {
                // 要垫的方块位置 = 起跳前脚站的那一格（起跳后它已经空了）
                BlockPos ground = BlockPos.containing(p.getX(), pillarStartY - 0.5, p.getZ());
                if (mc.level.getBlockState(ground).isAir()) ground = ground.below();

                Vec3 hit = new Vec3(ground.getX() + 0.5, ground.getY() + 1.0, ground.getZ() + 0.5);
                BlockHitResult bhr = new BlockHitResult(hit, Direction.UP, ground, false);
                if (mc.gameMode != null) {
                    mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, bhr);
                }
                SyntheticInput.clearMovement();
                pillarPhase = 2;
            }
            return;
        }

        // phase 2：等落到新方块上。rise < 0.5 说明方块没放出去，再等也没用。
        if (p.onGround()) {
            double rise = p.getY() - pillarStartY;
            if (rise < 0.5) { pillarFinish(false, "方块没放下去（快捷栏方块用完了？）"); return; }
            pillarPlaced++;
            if (pillarPlaced >= pillarTarget) { pillarFinish(true, ""); return; }
            pillarPhase = 0;
        }
    }

    private static void pillarFinish(boolean ok, String error) {
        pillarActive = false;
        SyntheticInput.clearMovement();
        CompletableFuture<String> f = pillarFuture;
        pillarFuture = null;
        if (f == null || f.isDone()) return;
        if (ok) {
            LocalPlayer p = Minecraft.getInstance().player;
            double y = p == null ? 0 : p.getY();
            f.complete(String.format("{\"ok\":true,\"blocks\":%d,\"y\":%.2f}", pillarPlaced, y));
        } else {
            f.complete("{\"ok\":false,\"error\":\"" + escape(error) + "\",\"blocks\":" + pillarPlaced + "}");
        }
    }

    /**
     * 读当前交易报价。
     *
     * 之前 JS 只能看到「7 个空白按钮」，不知道村民卖什么、材料够不够，
     * 点一下没成交也照报成功。把报价读出来，选交易和验证才有依据。
     */
    private static void handleTrades(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            if (!(p.containerMenu instanceof net.minecraft.world.inventory.MerchantMenu menu)) {
                return "{\"ok\":false,\"error\":\"没有打开交易界面\"}";
            }

            net.minecraft.world.item.trading.MerchantOffers offers = menu.getOffers();
            StringBuilder sb = new StringBuilder(512);
            sb.append("{\"ok\":true,\"count\":").append(offers.size()).append(",\"offers\":[");
            for (int i = 0; i < offers.size(); i++) {
                net.minecraft.world.item.trading.MerchantOffer o = offers.get(i);
                net.minecraft.world.item.trading.ItemCost a = o.getItemCostA();
                java.util.Optional<net.minecraft.world.item.trading.ItemCost> b = o.getItemCostB();
                if (i > 0) sb.append(',');
                sb.append("{\"i\":").append(i)
                  .append(",\"a\":{\"id\":\"").append(escape(itemId(a.itemStack()))).append("\",\"n\":").append(a.count()).append('}')
                  .append(",\"b\":");
                if (b.isPresent()) {
                    net.minecraft.world.item.trading.ItemCost c = b.get();
                    sb.append("{\"id\":\"").append(escape(itemId(c.itemStack()))).append("\",\"n\":").append(c.count()).append('}');
                } else {
                    sb.append("null");
                }
                ItemStack out = o.getResult();
                sb.append(",\"out\":{\"id\":\"").append(escape(itemId(out))).append("\",\"n\":").append(out.getCount()).append('}')
                  .append(",\"uses\":").append(o.getUses())
                  .append(",\"maxUses\":").append(o.getMaxUses())
                  .append(",\"outOfStock\":").append(o.isOutOfStock())
                  .append('}');
            }
            return sb.append("]}").toString();
        });
        respond(ex, body);
    }

    /**
     * 直接对最近的某类实体右键。
     *
     * 走 gameMode.interact + 构造 EntityHitResult，不依赖准星射线：
     * 村民会走动、树冠地形挡视线，靠 lookAt 经常打到方块。服务端只校验
     * 距离和实体 id，不要求客户端 hitResult 真的对准。
     */
    private static void handleInteract(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String type = str(raw, "type");
        Double dNum = num(raw, "dist");
        final double maxDist = Math.max(1.0, Math.min(6.0, dNum == null ? 3.2 : dNum));
        if (type == null || type.isEmpty()) {
            respond(ex, "{\"ok\":false,\"error\":\"need type\"}");
            return;
        }
        final String want = type.toLowerCase();

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            ClientLevel level = mc.level;
            if (p == null || level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            Entity best = null;
            double bestDist = Double.MAX_VALUE;
            // 不能用 entitiesForRendering：它只给当前视锥里正在渲染的实体，
            // 背后的村民/怪会「不存在」。按 AABB 查已加载实体。
            for (Entity e : level.getEntities(p, p.getBoundingBox().inflate(maxDist), x -> true)) {
                if (e == p || !e.isAlive()) continue;
                if (!entityId(e).toLowerCase().contains(want)) continue;
                double d = e.distanceTo(p);
                if (d <= maxDist && d < bestDist) { best = e; bestDist = d; }
            }
            if (best == null) {
                return "{\"ok\":false,\"error\":\"附近 " + maxDist + " 格内没有 " + want + "\"}";
            }
            if (mc.gameMode != null) {
                mc.gameMode.interact(p, best, new EntityHitResult(best), InteractionHand.MAIN_HAND);
            }
            return "{\"ok\":true,\"id\":\"" + entityId(best) + "\",\"dist\":" + fmt(bestDist) + "}";
        });
        respond(ex, body);
    }

    /**
     * 往前搭桥：每次在脚下方块的侧面贴一块，然后往前走上去。
     *
     * 前提是玩家已经面向要去的方向（引擎会先 look）。搭桥不能靠瞬移，
     * 否则会悬空；这里用「站在现有方块上 → 贴侧面 → 走半步」的循环，
     * 只要还有方块，脚下就一直是实心的。
     */
    private static void handleBridge(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double countNum = num(raw, "count");
        final int count = Math.max(1, Math.min(24, countNum == null ? 1 : countNum.intValue()));

        String start = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            int slot = findPlaceableSlot(p);
            if (slot < 0) return "{\"ok\":false,\"error\":\"快捷栏里没有可放置的方块\"}";
            p.getInventory().setSelectedSlot(slot);
            return "{\"ok\":true}";
        });
        if (!start.contains("\"ok\":true")) { respond(ex, start); return; }

        int placed = 0;
        String error = "";
        for (int i = 0; i < count; i++) {
            final int step = i;
            String r = onClientThread(() -> {
                Minecraft mc = Minecraft.getInstance();
                LocalPlayer p = mc.player;
                if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

                BlockPos support = BlockPos.containing(p.getX(), p.getY() - 0.5, p.getZ());
                if (mc.level.getBlockState(support).isAir()) support = support.below();
                Direction dir = p.getDirection();
                BlockPos target = support.relative(dir);

                BlockState ts = mc.level.getBlockState(target);
                if (!ts.isAir() && !ts.canBeReplaced()) {
                    return "{\"ok\":true,\"skipped\":true,\"i\":" + step + "}";
                }

                // 贴在脚下这块方块的侧面上，落点就是 target
                Vec3 hit = new Vec3(
                    support.getX() + 0.5 + dir.getStepX() * 0.49,
                    support.getY() + 0.5,
                    support.getZ() + 0.5 + dir.getStepZ() * 0.49);
                if (mc.gameMode != null) {
                    mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND,
                        new BlockHitResult(hit, dir, support, false));
                }
                return "{\"ok\":true,\"i\":" + step + "}";
            });

            if (!r.contains("\"ok\":true")) { error = r; break; }
            if (!r.contains("\"skipped\":true")) placed += 1;

            // 走上去：步行速度约 4.3 格/秒，220ms 约 0.7 格，
            // 足够挪到新方块中心，又不会冲过头掉下去。
            SyntheticInput.setMovement(true, false, false, false, false, false, false, 400);
            try { Thread.sleep(220); } catch (InterruptedException ignored) { }
            SyntheticInput.clearMovement();
            try { Thread.sleep(80); } catch (InterruptedException ignored) { }

            final int expect = placed;
            String check = onClientThread(() -> {
                Minecraft mc = Minecraft.getInstance();
                LocalPlayer p = mc.player;
                if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";
                return "{\"ok\":true,\"y\":" + String.format("%.2f", p.getY()) + ",\"n\":" + expect + "}";
            });
            if (!check.contains("\"ok\":true")) { error = check; break; }
        }

        if (placed == 0) {
            respond(ex, "{\"ok\":false,\"error\":\"一块也没搭成（前方不是空地？）\"}");
            return;
        }
        respond(ex, "{\"ok\":true,\"blocks\":" + placed + (error.isEmpty() ? "" : ",\"warning\":\"" + escape(error) + "\"") + "}");
    }

    /**
     * 接收 Node 的可视化状态：路径、目标、动作、进度、开关。
     * 只更新 volatile 快照，渲染线程下一帧就能读到。
     */
    private static void handleVisualize(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String action = str(raw, "action");
        String status = str(raw, "status");
        Double progressNum = num(raw, "progress");
        double progress = progressNum == null ? 0 : Math.max(0, Math.min(1, progressNum));

        double[] path = parsePoints(raw, "path", 64);
        double[] target = parseTriplet(raw, "target");
        boolean hasTarget = target != null;

        boolean flow = !raw.contains("\"flow\":false");
        boolean targetBox = !raw.contains("\"targetBox\":false");
        boolean beam = !raw.contains("\"beam\":false");
        boolean trail = !raw.contains("\"trail\":false");
        boolean hud = !raw.contains("\"hud\":false");

        VisualizationState.update(path,
            hasTarget ? target[0] : 0,
            hasTarget ? target[1] : 0,
            hasTarget ? target[2] : 0,
            hasTarget,
            action == null ? "" : action,
            status == null ? "" : status,
            progress,
            flow, targetBox, beam, trail, hud);

        respond(ex, "{\"ok\":true,\"path\":" + (path.length / 3) + ",\"target\":" + hasTarget + "}");
    }

    /**
     * 立即清空合成输入：悬崖边必须真正停下，而不是只把任务标记为暂停。
     * 惯性/持续按键可能让玩家在下一 tick 继续走。
     */
    private static void handleStop(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            SyntheticInput.clearMovement();
            synthActive = false;
            LocalPlayer p = Minecraft.getInstance().player;
            if (p != null && p.input != null) {
                p.input.keyPresses = net.minecraft.world.entity.player.Input.EMPTY;
            }
            return "{\"ok\":true}";
        });
        respond(ex, body);
    }

    /**
     * 在指定坐标放一个方块（任务队列搭房子用）。
     *
     * 找一个相邻的实心方块作为支撑，构造 BlockHitResult，直接调 useItemOn；
     * 不依赖准星射线，只要目标在 4.5 格内服务端就会接受。
     */
    private static void handlePlace(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double x = num(raw, "x");
        Double y = num(raw, "y");
        Double z = num(raw, "z");
        String want = str(raw, "block");
        if (x == null || y == null || z == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need x/y/z\"}");
            return;
        }
        final String block = want == null ? "" : want.toLowerCase().replace("minecraft:", "");

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            BlockPos target = BlockPos.containing(x, y, z);
            BlockState cur = mc.level.getBlockState(target);
            if (!cur.canBeReplaced()) {
                return "{\"ok\":true,\"placed\":false,\"already\":true,"
                    + "\"id\":\"" + escape(blockId(mc.level, target)) + "\"}";
            }

            int slot = findPlaceableSlot(p, block);
            if (slot < 0) {
                return "{\"ok\":false,\"error\":\"" + (block.isEmpty() ? "快捷栏里没有可放置的方块" : "快捷栏里没有 " + block) + "\"}";
            }
            p.getInventory().setSelectedSlot(slot);

            double px = p.getX(), py = p.getEyeY(), pz = p.getZ();
            boolean anySupport = false;
            boolean tooFar = false;

            // 逐个尝试相邻的实心面：下面放不上去就试侧面/上面。
            // 只试第一个面时，某些朝向（比如贴着床/工作台）会一直失败。
            for (Direction d : Direction.values()) {
                BlockPos support = target.relative(d);
                if (mc.level.getBlockState(support).canBeReplaced()) continue;
                anySupport = true;

                double dist = Math.sqrt(Math.pow(support.getX() + 0.5 - px, 2)
                    + Math.pow(support.getY() + 0.5 - py, 2)
                    + Math.pow(support.getZ() + 0.5 - pz, 2));
                if (dist > 4.6) { tooFar = true; continue; }

                Direction face = d.getOpposite();
                Vec3 hit = new Vec3(
                    support.getX() + 0.5 + face.getStepX() * 0.49,
                    support.getY() + 0.5 + face.getStepY() * 0.49,
                    support.getZ() + 0.5 + face.getStepZ() * 0.49);
                if (mc.gameMode != null) {
                    mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND,
                        new BlockHitResult(hit, face, support, false));
                }
                if (!mc.level.getBlockState(target).canBeReplaced()) {
                    return "{\"ok\":true,\"placed\":true,\"id\":\""
                        + escape(blockId(mc.level, target)) + "\"}";
                }
            }

            if (!anySupport) return "{\"ok\":false,\"error\":\"目标周围没有可依附的方块\"}";
            if (tooFar) return "{\"ok\":false,\"error\":\"太远（>4.6 格），先 goto 靠近\"}";
            return "{\"ok\":false,\"error\":\"放置被拒绝（周围面都试过了）\"}";
        });
        respond(ex, body);
    }

    /**
     * 直接攻击最近的某类实体，不依赖准星。
     *
     * 怪会移动，aimEntity 用的是上一帧坐标，攻击包到达时经常已经偏了；
     * 而且 client 的 attack() 还要求 hitResult 命中。这里直接按实体 id 调
     * gameMode.attack，服务端按距离校验，命中稳定得多。
     */
    private static void handleHit(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String type = str(raw, "type");
        Double dNum = num(raw, "dist");
        Double eidNum = num(raw, "eid");
        final double maxDist = Math.max(1.0, Math.min(6.0, dNum == null ? 3.0 : dNum));
        final String want = type == null ? "" : type.toLowerCase().replace("minecraft:", "");
        final long wantEid = eidNum == null ? Long.MIN_VALUE : eidNum.longValue();

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            ClientLevel level = mc.level;
            if (p == null || level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            Entity best = null;
            double bestDist = Double.MAX_VALUE;
            for (Entity e : level.getEntities(p, p.getBoundingBox().inflate(maxDist), x -> true)) {
                if (e == p || !e.isAlive() || !(e instanceof net.minecraft.world.entity.LivingEntity)) continue;
                if (wantEid != Long.MIN_VALUE && e.getId() != wantEid) continue;
                if (!want.isEmpty() && !entityId(e).toLowerCase().contains(want)) continue;
                double d = e.distanceTo(p);
                if (d <= maxDist && d < bestDist) { best = e; bestDist = d; }
            }
            if (best == null) {
                return "{\"ok\":false,\"error\":\"附近 " + maxDist + " 格内没有可攻击的 "
                    + (want.isEmpty() ? "生物" : want) + "\"}";
            }
            if (mc.gameMode != null) mc.gameMode.attack(p, best);
            double hp = best instanceof net.minecraft.world.entity.LivingEntity le ? le.getHealth() : -1;
            return "{\"ok\":true,\"id\":\"" + entityId(best) + "\",\"dist\":" + fmt(bestDist)
                + String.format(",\"hp\":%.1f}", hp);
        });
        respond(ex, body);
    }

    /**
     * 选当前方块最合适的工具（按原版规则，不是硬编码物品名）。
     *
     * 扫描整个背包：正确工具优先，其次挖掘速度；只返回候选，不跨背包搬运。
     * 物品在快捷栏时直接选中；在主背包时返回 item，让 Node 侧先挪到快捷栏。
     */
    private static void handleBestTool(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double x = num(raw, "x");
        Double y = num(raw, "y");
        Double z = num(raw, "z");
        if (x == null || y == null || z == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need x/y/z\"}");
            return;
        }
        final double fx = x, fy = y, fz = z;
        final boolean hotbarOnly = raw.contains("\"hotbarOnly\":true");

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            BlockPos pos = BlockPos.containing(fx, fy, fz);
            BlockState state = mc.level.getBlockState(pos);
            if (state.isAir()) return "{\"ok\":false,\"error\":\"the block is air\"}";

            boolean needTool = state.requiresCorrectToolForDrops();
            Choice best = new Choice();
            List<ItemStack> items = p.getInventory().getNonEquipmentItems();
            int limit = hotbarOnly ? Math.min(9, items.size()) : items.size();
            for (int i = 0; i < limit; i++) {
                ItemStack stack = items.get(i);
                if (stack == null || stack.isEmpty()) continue;
                int max = stack.getMaxDamage();
                if (max > 0 && max - stack.getDamageValue() <= 1) continue;

                boolean correct = stack.isCorrectToolForDrops(state);
                float speed = stack.getDestroySpeed(state);
                if (!correct && speed <= 1.0f) continue;

                // Efficiency 不体现在 getDestroySpeed 里；按原版近似加 level²+1
                int efficiency = enchantLevel(stack, "efficiency");
                if (correct && efficiency > 0) speed += efficiency * efficiency + 1.0f;

                double score = (correct ? 1000.0 : 0.0) + speed;
                if (score > best.score) {
                    best.score = score;
                    best.slot = i < 9 ? i : -1;
                    best.item = itemId(stack);
                    best.correct = correct;
                    best.ench = enchantJson(stack);
                }
            }

            if (best.item.isEmpty()) {
                return "{\"ok\":true,\"slot\":-1,\"item\":\"\",\"inInventory\":false,"
                    + "\"correct\":false,\"needTool\":" + needTool + ",\"switched\":false,\"ench\":{}}";
            }

            boolean switched = false;
            if (best.slot >= 0 && best.slot != p.getInventory().getSelectedSlot()) {
                p.getInventory().setSelectedSlot(best.slot);
                switched = true;
            }
            return "{\"ok\":true,\"slot\":" + best.slot
                + ",\"item\":\"" + escape(best.item) + "\""
                + ",\"inInventory\":" + (best.slot < 0)
                + ",\"correct\":" + best.correct
                + ",\"needTool\":" + needTool
                + ",\"switched\":" + switched
                + ",\"ench\":" + best.ench + "}";
        });
        respond(ex, body);
    }

    /**
     * 选最高 DPS 的近战武器。
     *
     * 不按“剑>斧”硬编码：直接读物品的 ATTACK_DAMAGE/ATTACK_SPEED 修饰符，
     * 这样模组武器、重锤、三叉戟都能参与比较；空手 DPS 约 4，低于它的不切。
     */
    private static void handleBestWeapon(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        final boolean hotbarOnly = raw.contains("\"hotbarOnly\":true");
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            Choice best = new Choice();
            List<ItemStack> items = p.getInventory().getNonEquipmentItems();
            int limit = hotbarOnly ? Math.min(9, items.size()) : items.size();
            for (int i = 0; i < limit; i++) {
                ItemStack stack = items.get(i);
                if (stack == null || stack.isEmpty()) continue;
                int max = stack.getMaxDamage();
                if (max > 0 && max - stack.getDamageValue() <= 1) continue;

                double score = weaponScore(stack);
                if (score <= 4.01) continue;
                if (score > best.score) {
                    best.score = score;
                    best.slot = i < 9 ? i : -1;
                    best.item = itemId(stack);
                    best.ench = enchantJson(stack);
                }
            }

            if (best.item.isEmpty()) {
                return "{\"ok\":true,\"slot\":-1,\"item\":\"\",\"inInventory\":false,\"switched\":false,\"ench\":{}}";
            }

            boolean switched = false;
            if (best.slot >= 0 && best.slot != p.getInventory().getSelectedSlot()) {
                p.getInventory().setSelectedSlot(best.slot);
                switched = true;
            }
            return String.format(java.util.Locale.ROOT,
                "{\"ok\":true,\"slot\":%d,\"item\":\"%s\",\"inInventory\":%b,\"switched\":%b,\"dps\":%.2f,\"ench\":%s}",
                best.slot, escape(best.item), best.slot < 0, switched, best.score, best.ench);
        });
        respond(ex, body);
    }

    /**
     * 选每个护甲槽的最佳备用件（含附魔）。
     * 只返回“比当前更好”的候选；Node 侧再逐个 equip 并校验。
     */
    private static void handleBestArmor(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            String[] slots = { "boots", "leggings", "chest", "helmet" };
            List<ItemStack> items = p.getInventory().getNonEquipmentItems();
            StringBuilder arr = new StringBuilder("[");
            int n = 0;

            for (int idx = 0; idx < slots.length; idx++) {
                ItemStack cur = armorStack(p, idx);
                double curScore = armorItemScore(cur);
                ItemStack best = null;
                double bestScore = curScore;
                int bestInvSlot = -1;

                for (int i = 0; i < items.size(); i++) {
                    ItemStack stack = items.get(i);
                    if (stack == null || stack.isEmpty()) continue;
                    if (!armorMatchesSlot(itemId(stack), idx)) continue;
                    int max = stack.getMaxDamage();
                    if (max > 0 && max - stack.getDamageValue() <= 1) continue;
                    double score = armorItemScore(stack);
                    if (score > bestScore) {
                        bestScore = score;
                        best = stack;
                        bestInvSlot = i;
                    }
                }

                if (best == null) continue;
                if (n++ > 0) arr.append(',');
                arr.append("{\"slot\":\"").append(slots[idx]).append('"')
                   .append(",\"item\":\"").append(escape(itemId(best))).append('"')
                   .append(",\"invSlot\":").append(bestInvSlot)
                   .append(",\"current\":\"").append(escape(cur == null ? "" : itemId(cur))).append('"')
                   .append(String.format(java.util.Locale.ROOT, ",\"score\":%.2f", bestScore))
                   .append(",\"ench\":").append(enchantJson(best)).append('}');
            }
            arr.append(']');
            return "{\"ok\":true,\"recommend\":" + arr + "}";
        });
        respond(ex, body);
    }

    /** 护甲槽 0=靴 1=腿 2=胸 3=头。 */
    private static boolean armorMatchesSlot(String id, int slot) {
        if (id == null) return false;
        String n = id.replace("minecraft:", "");
        return switch (slot) {
            case 0 -> n.endsWith("_boots");
            case 1 -> n.endsWith("_leggings");
            case 2 -> n.endsWith("_chestplate");
            case 3 -> n.endsWith("_helmet") || n.equals("turtle_helmet");
            default -> false;
        };
    }

    /** 护甲材料分 + 保护类附魔；只用于比较同槽。 */
    private static double armorItemScore(ItemStack st) {
        if (st == null || st.isEmpty()) return 0;
        String id = itemId(st).replace("minecraft:", "");
        double base = 0;
        if (id.startsWith("netherite_")) base = 6;
        else if (id.startsWith("diamond_")) base = 5;
        else if (id.startsWith("iron_")) base = 4;
        else if (id.startsWith("chainmail_")) base = 3;
        else if (id.startsWith("golden_")) base = 2;
        else if (id.startsWith("leather_")) base = 1;
        else if (id.equals("turtle_helmet")) base = 3;

        double ench = enchantLevel(st, "protection") * 3.0
            + enchantLevel(st, "blast_protection") * 1.5
            + enchantLevel(st, "projectile_protection") * 1.5
            + enchantLevel(st, "fire_protection") * 1.5
            + enchantLevel(st, "thorns") * 0.5
            + enchantLevel(st, "unbreaking") * 0.1;
        int max = st.getMaxDamage();
        double ratio = max <= 0 ? 1.0 : Math.max(0.0, (double) (max - st.getDamageValue()) / max);
        return base * 10.0 + ench + ratio * 0.5;
    }

    /**
     * Baritone 全局寻路。Baritone 是可选依赖：没装时这里返回 available:false，
     * Node 侧会自动退回本地 goto，不让整个 agent 挂掉。
     */
    private static void handleBaritoneGoto(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double x = num(raw, "x");
        Double y = num(raw, "y");
        Double z = num(raw, "z");
        Double rangeNum = num(raw, "range");
        if (x == null || z == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need x/z\"}");
            return;
        }
        final double fx = x, fz = z;
        final Double fy = y;
        final int range = (int) Math.max(1, Math.min(8, rangeNum == null ? 2 : Math.round(rangeNum)));
        String body = onClientThread(() -> {
            try {
                return BaritonePathing.gotoPath(fx, fy, fz, range);
            } catch (Throwable t) {
                return "{\"ok\":false,\"available\":false,\"error\":\""
                    + escape(t.getClass().getSimpleName() + ": " + t.getMessage()) + "\"}";
            }
        });
        respond(ex, body);
    }

    private static void handleBaritoneStatus(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            try {
                return BaritonePathing.status();
            } catch (Throwable t) {
                return "{\"ok\":false,\"available\":false,\"error\":\""
                    + escape(t.getClass().getSimpleName() + ": " + t.getMessage()) + "\"}";
            }
        });
        respond(ex, body);
    }

    private static void handleBaritoneStop(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            try {
                return BaritonePathing.stop();
            } catch (Throwable t) {
                return "{\"ok\":false,\"available\":false,\"error\":\""
                    + escape(t.getClass().getSimpleName() + ": " + t.getMessage()) + "\"}";
            }
        });
        respond(ex, body);
    }

    /** 近战 DPS：基础 1 伤害 + 物品修饰符，乘攻击速度；低耐久略降权。 */
    private static double weaponScore(ItemStack stack) {
        final double[] damage = { 1.0 };
        final double[] speed = { 4.0 };
        stack.forEachModifier(EquipmentSlot.MAINHAND, (attr, mod) -> {
            if (attr.value() == Attributes.ATTACK_DAMAGE.value()) damage[0] += mod.amount();
            else if (attr.value() == Attributes.ATTACK_SPEED.value()) speed[0] += mod.amount();
        });
        // 锋利：原版每级约 +0.5 伤害，另有基础 +0.5；只用于比较同槽武器
        int sharpness = enchantLevel(stack, "sharpness");
        if (sharpness > 0) damage[0] += 0.5 * sharpness + 0.5;
        int max = stack.getMaxDamage();
        double ratio = max <= 0 ? 1.0 : Math.max(0.0, (double) (max - stack.getDamageValue()) / max);
        return damage[0] * Math.max(0.2, speed[0]) * (0.85 + 0.15 * ratio);
    }

    /** 最近一次选工具/武器的扫描结果。 */
    private static final class Choice {
        int slot = -1;
        String item = "";
        double score = 0;
        boolean correct = false;
        String ench = "{}";
    }

    /**
     * 展开鞘翅。
     *
     * 不靠模拟跳跃：26.3 的 jumpTriggerTime 把「连按两次跳跃」优先解释成
     * 切创造飞行，合成按键经常触发不了 tryToStartFallFlying。
     * 这里直接调用它，并补发 LocalPlayer 成功时才会发的 START_FALL_FLYING 包。
     */
    private static void handleGlide(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        final boolean stop = raw.contains("\"stop\":true");
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            if (stop) {
                p.stopFallFlying();
                return "{\"ok\":true,\"flying\":false}";
            }
            if (p.isFallFlying()) {
                return "{\"ok\":true,\"flying\":true,\"already\":true}";
            }
            boolean started = p.tryToStartFallFlying();
            if (started && p.connection != null) {
                p.connection.send(new net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket(
                    p,
                    net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket.Action.START_FALL_FLYING));
            }
            return "{\"ok\":" + started + ",\"flying\":" + p.isFallFlying()
                + ",\"onGround\":" + p.onGround()
                + String.format(",\"y\":%.2f}", p.getY());
        });
        respond(ex, body);
    }

    /** 关掉暂停界面：窗口失焦时 MC 会自动弹游戏菜单，整个模拟会停住。 */
    private static void handleResume(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            // 只关界面不够：pauseIfInactive 下一 tick 会按 options 再暂停一次
            if (mc.options != null) mc.options.pauseOnLostFocus = false;
            if (currentScreen() instanceof net.minecraft.client.gui.screens.PauseScreen) {
                mc.gui.setScreen(null);
            }
            return "{\"ok\":true,\"paused\":" + mc.isPaused() + ",\"screen\":\"" + currentScreenName() + "\"}";
        });
        respond(ex, body);
    }

    /** 诊断：输入到底走哪条路（走路不动的排查用） */
    private static void handleInputDebug(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || p.input == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            net.minecraft.world.entity.player.Input kp = p.input.keyPresses;
            StringBuilder sb = new StringBuilder(256);
            sb.append("{\"ok\":true");
            sb.append(",\"inputClass\":\"").append(p.input.getClass().getSimpleName()).append('"');
            sb.append(",\"keyUpDown\":").append(mc.options.keyUp.isDown());
            sb.append(",\"keyJumpDown\":").append(mc.options.keyJump.isDown());
            if (kp != null) {
                sb.append(",\"presses\":{\"f\":").append(kp.forward())
                  .append(",\"b\":").append(kp.backward())
                  .append(",\"l\":").append(kp.left())
                  .append(",\"r\":").append(kp.right())
                  .append(",\"j\":").append(kp.jump())
                  .append(",\"sh\":").append(kp.shift())
                  .append(",\"sp\":").append(kp.sprint()).append('}');
            } else {
                sb.append(",\"presses\":null");
            }
            sb.append(",\"synthActive\":").append(synthActive);
            sb.append(",\"onGround\":").append(p.onGround());
            sb.append(",\"moveVec\":\"").append(p.input.getMoveVector()).append('"');
            sb.append('}');
            return sb.toString();
        });
        respond(ex, body);
    }

    private static void handleKey(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String key = str(raw, "key");
        boolean down = raw.contains("\"down\":true");
        if (key == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need key\"}");
            return;
        }

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.player == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            switch (key.toLowerCase()) {
                case "w" -> mc.options.keyUp.setDown(down);
                case "s" -> mc.options.keyDown.setDown(down);
                case "a" -> mc.options.keyLeft.setDown(down);
                case "d" -> mc.options.keyRight.setDown(down);
                case "space", "jump" -> mc.options.keyJump.setDown(down);
                case "shift", "sneak" -> mc.options.keyShift.setDown(down);
                case "sprint" -> mc.options.keySprint.setDown(down);
                // 吃东西要「按住右键」1.6 秒才生效，单次 useItem 不够
                case "use", "right" -> mc.options.keyUse.setDown(down);
                case "attack", "left" -> mc.options.keyAttack.setDown(down);
                default -> {
                    return "{\"ok\":false,\"error\":\"unknown key\"}";
                }
            }
            return String.format("{\"ok\":true,\"key\":\"%s\",\"down\":%b}", key, down);
        });
        respond(ex, body);
    }

    private static void handleChat(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String text = str(raw, "text");
        if (text == null || text.trim().isEmpty()) {
            respond(ex, "{\"ok\":false,\"error\":\"need text\"}");
            return;
        }
        final String msg = text.trim();

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.player == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            if (mc.getConnection() == null) return "{\"ok\":false,\"error\":\"no connection\"}";
            if (msg.startsWith("/")) {
                // sendCommand 不会在聊天栏留下痕迹，也不需要开关聊天界面
                mc.getConnection().sendCommand(msg.substring(1));
                return "{\"ok\":true,\"mode\":\"command\",\"text\":\"" + escape(msg) + "\"}";
            }
            mc.getConnection().sendChat(msg);
            return "{\"ok\":true,\"mode\":\"chat\",\"text\":\"" + escape(msg) + "\"}";
        });
        respond(ex, body);
    }

    private static void handleAttack(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            if (mc.gameMode == null) return "{\"ok\":false,\"error\":\"no game mode\"}";

            HitResult hit = mc.hitResult;
            if (hit instanceof EntityHitResult) {
                Entity target = ((EntityHitResult) hit).getEntity();
                mc.gameMode.attack(p, target);
                return "{\"ok\":true,\"hit\":\"entity\",\"id\":\"" + entityId(target) + "\"}";
            }
            if (hit instanceof BlockHitResult) {
                BlockHitResult bhr = (BlockHitResult) hit;
                BlockPos pos = bhr.getBlockPos();
                Direction face = bhr.getDirection();
                // 模拟按住左键：起手 + 连续推进 + 松手。创造模式第一下就碎，
                // 生存模式靠 continueDestroyBlock 累积破坏进度。
                mc.gameMode.startDestroyBlock(pos, face);
                for (int i = 0; i < 6 && !mc.level.getBlockState(pos).isAir(); i++) {
                    mc.gameMode.continueDestroyBlock(pos, face);
                }
                mc.gameMode.stopDestroyBlock();
                boolean broken = mc.level.getBlockState(pos).isAir();
                return "{\"ok\":true,\"hit\":\"block\",\"pos\":[" + pos.getX() + "," + pos.getY() + "," + pos.getZ()
                    + "],\"broken\":" + broken + "}";
            }
            return "{\"ok\":true,\"hit\":\"none\"}";
        });
        respond(ex, body);
    }

    /**
     * 按坐标挖方块。
     *
     * 为什么不复用 /attack：那条走的是 mc.hitResult（准星命中结果），刚转完视角时
     * hitResult 还是上一帧的，容易挖到旁边；而且原来固定只推进 6 帧破坏进度，
     * 硬度大于 ~3 的方块根本挖不动。这里直接按坐标算朝向、按硬度算需要的帧数。
     */
    private static void handleMine(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double x = num(raw, "x");
        Double y = num(raw, "y");
        Double z = num(raw, "z");
        if (x == null || y == null || z == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need x/y/z\"}");
            return;
        }

        // 0=pos 1=face 2=need 3=err
        final Object[] prep = new Object[4];

        onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) { prep[3] = "not in world"; return "{}"; }
            if (mc.gameMode == null) { prep[3] = "no game mode"; return "{}"; }

            BlockPos pos = BlockPos.containing(x, y, z);
            if (mc.level.getBlockState(pos).isAir()) { prep[3] = "already"; return "{}"; }

            double dx = pos.getX() + 0.5 - p.getX();
            double dy = pos.getY() + 0.5 - p.getEyeY();
            double dz = pos.getZ() + 0.5 - p.getZ();
            double horiz = Math.sqrt(dx * dx + dz * dz);
            if (horiz < 1.0e-4) horiz = 1.0e-4;

            float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
            float pitch = (float) -Math.toDegrees(Math.atan2(dy, horiz));
            p.setYRot(yaw);
            p.setXRot(pitch);
            p.setYHeadRot(yaw);

            BlockState st = mc.level.getBlockState(pos);
            float hardness = st.getDestroySpeed(mc.level, pos);
            if (hardness < 0) { prep[3] = "这个方块挖不掉"; return "{}"; }

            double vx = -dx, vy = -dy, vz = -dz;
            double ax = Math.abs(vx), ay = Math.abs(vy), az = Math.abs(vz);
            Direction face;
            if (ay >= ax && ay >= az) face = vy > 0 ? Direction.UP : Direction.DOWN;
            else if (ax >= az) face = vx > 0 ? Direction.EAST : Direction.WEST;
            else face = vz > 0 ? Direction.SOUTH : Direction.NORTH;

            float speed = Math.max(0.2f, p.getDestroySpeed(st));
            // 原版规则：每 tick 进度 += speed / hardness / 30。
            // 但「工具不对」时还有 3.33 倍惩罚（徒手挖石头就是这样），
            // 之前按 30 算，石头只给 51 帧（2.5 秒），实际要 150 帧（7.5 秒），
            // 于是每次都「挖了 91 帧还没碎」。这里按 100 估，留足余量。
            int need = (int) Math.ceil(hardness * 100.0f / speed) + 10;
            if (need > 500) need = 500;

            mc.gameMode.startDestroyBlock(pos, face);
            prep[0] = pos;
            prep[1] = face;
            prep[2] = need;
            return "{}";
        });

        if ("already".equals(prep[3])) {
            respond(ex, "{\"ok\":true,\"broken\":true,\"already\":true}");
            return;
        }
        if (prep[3] != null) {
            respond(ex, "{\"ok\":false,\"error\":\"" + escape(String.valueOf(prep[3])) + "\"}");
            return;
        }

        final BlockPos pos = (BlockPos) prep[0];
        final Direction face = (Direction) prep[1];
        final int need = (Integer) prep[2];
        final Minecraft mc = Minecraft.getInstance();
        final boolean[] broken = { false };

        // 关键：原版的挖掘进度是「每 tick 累积一次」，在同一个 tick 里循环调用几百次
        // 一点进度都不加（方块永远挖不掉）。必须每 50ms（约一 tick）提交一次，
        // 所以这段跑在 HTTP 线程上，用 mc.execute 把每次推进丢回渲染线程。
        int ticks = 0;
        for (int i = 0; i < need + 40; i++) {
            mc.execute(() -> {
                if (mc.gameMode == null || mc.level == null) return;
                mc.gameMode.continueDestroyBlock(pos, face);
                if (mc.level.getBlockState(pos).isAir()) broken[0] = true;
            });
            ticks++;
            try { Thread.sleep(50); } catch (InterruptedException ignored) { break; }
            if (broken[0]) break;
        }
        mc.execute(() -> { if (mc.gameMode != null) mc.gameMode.stopDestroyBlock(); });

        respond(ex, "{\"ok\":true,\"broken\":" + broken[0] + ",\"ticks\":" + ticks
            + ",\"pos\":[" + pos.getX() + "," + pos.getY() + "," + pos.getZ() + "]}");
    }

    private static void handleUse(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            if (mc.gameMode == null) return "{\"ok\":false,\"error\":\"no game mode\"}";

            HitResult hit = mc.hitResult;

            // 准星对着实体：右键是「和实体交互」（喂动物、开村民交易、给狗喂骨头都靠这条）。
            // 之前漏了这个分支，一律走 useItem，结果喂牛只是把小麦拿在手里挥了一下。
            if (hit instanceof net.minecraft.world.phys.EntityHitResult) {
                net.minecraft.world.phys.EntityHitResult ehr = (net.minecraft.world.phys.EntityHitResult) hit;
                net.minecraft.world.entity.Entity target = ehr.getEntity();
                mc.gameMode.interact(p, target, ehr, InteractionHand.MAIN_HAND);
                return "{\"ok\":true,\"on\":\"entity\",\"id\":\"" + entityId(target) + "\"}";
            }

            if (hit instanceof BlockHitResult) {
                BlockHitResult bhr = (BlockHitResult) hit;
                mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, bhr);
                BlockPos pos = bhr.getBlockPos();
                return "{\"ok\":true,\"on\":\"block\",\"pos\":[" + pos.getX() + "," + pos.getY() + "," + pos.getZ() + "]}";
            }
            mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);
            return "{\"ok\":true,\"on\":\"item\"}";
        });
        respond(ex, body);
    }

    /**
     * 开关游戏界面（背包 / 聊天栏 / 关闭）。
     *
     * 为什么不走 /key 模拟按 E：setDown 只是改按键状态，而开界面是在
     * Minecraft.handleKeybinds() 里用 consumeClick() 消费的，模拟不出「点一下」。
     * 进程内直接 setScreen 最稳，也不依赖用户的键位绑定。
     */
    /** 我们最后一次打开/关闭的界面。MC 26.3 里 Minecraft 没有公开的 screen 字段，
     *  直接读要反射，不如自己记一份——模型关心的本来就是「我刚开的东西还开着吗」。 */
    private static volatile String lastUi = "";

    /**
     * 「按住右键」的维持状态。
     *
     * 为什么要靠 tick 维持：MC 每帧会把按键状态刷回真实输入值（KeyMapping.setAll），
     * 合成的「右键按下」下一帧就没了，于是 startUsingItem 刚起来就被 stopUsingItem 掉
     * （实测 150ms 都撑不住，wasUsing 恒为 false）。
     * 所以改成：/usehold 只设定「保持到什么时候」，由 mod 的 tick 钩子每帧检查并续上。
     */
    static volatile boolean useHoldActive = false;
    static volatile long useHoldUntil = 0L;

    /**
     * 合成输入（走路/跳跃）。
     *
     * 26.3 里玩家的移动不再是「读 KeyMapping 的 isDown」，而是 `LocalPlayer.input.keyPresses`
     * 这个 Input 记录（forward/backward/left/right/jump/shift/sprint 七个 boolean）。
     * 只调 KeyMapping.setDown 实测玩家一动不动——走路一直是坏的，全靠 /move 瞬移在动。
     * 所以这里直接写 keyPresses，并由 tick 钩子每帧续上。
     */
    static volatile boolean synthActive = false;
    static volatile long synthUntil = 0L;
    static volatile boolean sF, sB, sL, sR, sJ, sShift, sSprint;

    /** 垫高状态机：0=准备跳 1=空中等放 2=等落地 */
    static volatile boolean pillarActive = false;
    static volatile int pillarTarget = 0;
    static volatile int pillarPlaced = 0;
    static volatile int pillarPhase = 0;
    static volatile double pillarStartY = 0;
    static volatile long pillarDeadline = 0L;
    static volatile CompletableFuture<String> pillarFuture = null;

    private static String uiName() {
        return lastUi;
    }

    /**
     * 读当前容器（背包、箱子、工作台、熔炉……）。
     * 槽位编号就是点击时用的编号，模型不用自己算布局。
     */
    private static void handleContainer(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            AbstractContainerMenu menu = p.containerMenu;
            if (menu == null) return "{\"ok\":false,\"error\":\"没有打开的容器\"}";

            StringBuilder sb = new StringBuilder(512);
            sb.append("{\"ok\":true,\"screen\":\"").append(escape(uiName())).append('"');
            // 菜单类型：FurnaceMenu / CraftingMenu / ChestMenu… JS 靠它判断开的是什么
            sb.append(",\"menu\":\"").append(escape(menu.getClass().getSimpleName())).append('"');
            sb.append(",\"size\":").append(menu.slots.size());
            sb.append(",\"slots\":[");
            for (int i = 0; i < menu.slots.size(); i++) {
                if (i > 0) sb.append(',');
                ItemStack st = menu.slots.get(i).getItem();
                if (st == null || st.isEmpty()) {
                    sb.append("null");
                    continue;
                }
                sb.append("{\"i\":").append(i)
                  .append(",\"id\":\"").append(escape(itemId(st))).append('"')
                  .append(",\"n\":").append(st.getCount()).append('}');
            }
            sb.append(']');

            ItemStack carried = menu.getCarried();
            sb.append(",\"carried\":");
            if (carried == null || carried.isEmpty()) {
                sb.append("null");
            } else {
                sb.append("{\"id\":\"").append(escape(itemId(carried))).append('"')
                  .append(",\"n\":").append(carried.getCount()).append('}');
            }
            sb.append('}');
            return sb.toString();
        });
        respond(ex, body);
    }

    /**
     * 点一个槽位。mode：
     *   left 普通左键（拿起/放下/交换）   right 右键（拿一半/放一个）
     *   shift 快速移动（整摞搬到另一边）  throw 丢出去
     *
     * 走 handleInventoryMouseClick，等价于真的用鼠标点，服务端认这个包。
     */
    private static void handleSlot(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double slotNum = num(raw, "slot");
        if (slotNum == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need slot\"}");
            return;
        }
        final int slot = slotNum.intValue();
        final String mode = str(raw, "mode") == null ? "left" : str(raw, "mode").toLowerCase();

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            if (mc.gameMode == null) return "{\"ok\":false,\"error\":\"no game mode\"}";
            AbstractContainerMenu menu = p.containerMenu;
            if (menu == null) return "{\"ok\":false,\"error\":\"没有打开的容器\"}";
            if (slot < 0 || slot >= menu.slots.size()) {
                return "{\"ok\":false,\"error\":\"槽位越界（0~" + (menu.slots.size() - 1) + "）\"}";
            }

            int button = 0;
            ContainerInput type = ContainerInput.PICKUP;
            switch (mode) {
                case "right" -> button = 1;
                case "shift" -> type = ContainerInput.QUICK_MOVE;
                case "throw" -> type = ContainerInput.THROW;
                default -> { /* left */ }
            }

            mc.gameMode.handleContainerInput(menu.containerId, slot, button, type, p);

            ItemStack after = menu.slots.get(slot).getItem();
            String now = (after == null || after.isEmpty())
                ? "空"
                : itemId(after).replace("minecraft:", "") + " x" + after.getCount();
            return "{\"ok\":true,\"slot\":" + slot + ",\"now\":\"" + escape(now) + "\"}";
        });
        respond(ex, body);
    }

    /** 26.3 的 Gui 提供了公开的 screen() 访问器，不用再反射 private 字段。 */
    static net.minecraft.client.gui.screens.Screen currentScreen() {
        try {
            return Minecraft.getInstance().gui.screen();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 当前界面上所有能点的控件（按钮、输入框、列表……），带屏幕坐标 */
    /**
     * 游戏设置：读全部 / 改单项。
     * 名字固定这几个，值是数字；难度和模式是服务端的东西，走指令改（chat 里发 /difficulty）。
     */
    /**
     * 多人服务器列表：读 / 加 / 删 / 连。
     * 直接读写工作目录下的 servers.dat（NBT，gzip），不依赖 GUI。
     * 连接走 ConnectScreen.startConnecting，等于点了「加入服务器」。
     */
    private static void handleServers(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String action = str(raw, "action");
        String name = str(raw, "name");
        String ip = str(raw, "ip");
        final java.nio.file.Path file = java.nio.file.Paths.get("servers.dat");

        // 加 / 删：先改文件
        if ("add".equals(action) || "remove".equals(action)) {
            if (ip == null || ip.isEmpty()) {
                respond(ex, "{\"ok\":false,\"error\":\"need ip\"}");
                return;
            }
            try {
                net.minecraft.nbt.CompoundTag root = java.nio.file.Files.exists(file)
                    ? net.minecraft.nbt.NbtIo.readCompressed(file, net.minecraft.nbt.NbtAccounter.unlimitedHeap())
                    : new net.minecraft.nbt.CompoundTag();

                net.minecraft.nbt.ListTag old = root.getListOrEmpty("servers");
                net.minecraft.nbt.ListTag next = new net.minecraft.nbt.ListTag();
                for (int i = 0; i < old.size(); i++) {
                    net.minecraft.nbt.CompoundTag c = old.getCompoundOrEmpty(i);
                    if (ip.equals(c.getStringOr("ip", ""))) continue;  // add 时等于覆盖
                    next.addAndUnwrap(c);
                }
                if ("add".equals(action)) {
                    net.minecraft.nbt.CompoundTag c = new net.minecraft.nbt.CompoundTag();
                    c.putString("name", (name == null || name.isEmpty()) ? ip : name);
                    c.putString("ip", ip);
                    next.addAndUnwrap(c);
                }
                root.put("servers", next);
                net.minecraft.nbt.NbtIo.writeCompressed(root, file);
            } catch (Throwable t) {
                respond(ex, "{\"ok\":false,\"error\":\"" + escape(t.getMessage()) + "\"}");
                return;
            }
        }

        // 连接
        if ("join".equals(action)) {
            if (ip == null || ip.isEmpty()) {
                respond(ex, "{\"ok\":false,\"error\":\"need ip\"}");
                return;
            }
            final String label = (name == null || name.isEmpty()) ? ip : name;
            String body = onClientThread(() -> {
                try {
                    Minecraft mc = Minecraft.getInstance();
                    net.minecraft.client.multiplayer.resolver.ServerAddress addr =
                        net.minecraft.client.multiplayer.resolver.ServerAddress.parseString(ip);
                    net.minecraft.client.multiplayer.ServerData data =
                        new net.minecraft.client.multiplayer.ServerData(label, ip,
                            net.minecraft.client.multiplayer.ServerData.Type.OTHER);
                    net.minecraft.client.gui.screens.ConnectScreen.startConnecting(
                        currentScreen(), mc, addr, data, false,
                        new net.minecraft.client.multiplayer.TransferState(
                            java.util.Map.of(), java.util.Map.of(), false));
                    return "{\"ok\":true,\"joining\":\"" + escape(ip) + "\"}";
                } catch (Throwable t) {
                    return "{\"ok\":false,\"error\":\"" + escape(t.getMessage()) + "\"}";
                }
            });
            respond(ex, body);
            return;
        }

        // 默认：读列表
        String body = onClientThread(() -> {
            StringBuilder sb = new StringBuilder(256);
            sb.append("{\"ok\":true,\"servers\":[");
            try {
                if (java.nio.file.Files.exists(file)) {
                    net.minecraft.nbt.CompoundTag root =
                        net.minecraft.nbt.NbtIo.readCompressed(file, net.minecraft.nbt.NbtAccounter.unlimitedHeap());
                    net.minecraft.nbt.ListTag list = root.getListOrEmpty("servers");
                    for (int i = 0; i < list.size(); i++) {
                        net.minecraft.nbt.CompoundTag c = list.getCompoundOrEmpty(i);
                        if (i > 0) sb.append(',');
                        sb.append("{\"name\":\"").append(escape(c.getStringOr("name", ""))).append('"')
                          .append(",\"ip\":\"").append(escape(c.getStringOr("ip", ""))).append('"')
                          .append('}');
                    }
                }
            } catch (Throwable t) {
                return "{\"ok\":false,\"error\":\"" + escape(t.getMessage()) + "\"}";
            }
            sb.append("]}");
            return sb.toString();
        });
        respond(ex, body);
    }

    /**
     * 合成：按物品名找配方 → 用配方书一键填格子 → 取走产物。
     *
     * 走的是原版配方书那条路（handlePlaceRecipe），所以 2x2 / 3x3 / 无序配方都能处理，
     * 不用自己维护配方表，也不会绕过服务端校验。
     *
     * 前提：合成界面得开着。玩家背包（2x2）默认就是开着的 containerMenu；
     * 3x3 要先右键工作台。
     */
    private static void handleCraft(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        final String want = str(raw, "item");
        if (want == null || want.isEmpty()) {
            respond(ex, "{\"ok\":false,\"error\":\"need item\"}");
            return;
        }

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            final String target = want.startsWith("minecraft:") ? want.substring(10) : want;

            try {
                net.minecraft.util.context.ContextMap ctx =
                    net.minecraft.world.item.crafting.display.SlotDisplayContext.fromLevel(mc.level);

                net.minecraft.world.item.crafting.display.RecipeDisplayId found = null;
                String foundName = "";
                int craftable = 0;

                outer:
                for (net.minecraft.client.gui.screens.recipebook.RecipeCollection coll
                        : p.getRecipeBook().getCollections()) {
                    for (net.minecraft.world.item.crafting.display.RecipeDisplayEntry entry : coll.getRecipes()) {
                        java.util.List<net.minecraft.world.item.ItemStack> results = entry.resultItems(ctx);
                        if (results.isEmpty()) continue;
                        // itemId() 带 minecraft: 前缀，target 是剥过的，比较前要去掉
                        String id = itemId(results.get(0)).replace("minecraft:", "");
                        if (!id.equals(target)) continue;
                        found = entry.id();
                        foundName = id;
                        if (coll.isCraftable(entry.id())) { craftable = 1; break outer; }
                        break;
                    }
                }

                if (found == null) {
                    // 诊断：把配方书里到底有什么吐出来，不然只能猜
                    StringBuilder sample = new StringBuilder();
                    int total = 0;
                    for (net.minecraft.client.gui.screens.recipebook.RecipeCollection coll
                            : p.getRecipeBook().getCollections()) {
                        for (net.minecraft.world.item.crafting.display.RecipeDisplayEntry entry : coll.getRecipes()) {
                            total++;
                            java.util.List<net.minecraft.world.item.ItemStack> rs = entry.resultItems(ctx);
                            if (!rs.isEmpty() && sample.length() < 200) {
                                if (sample.length() > 0) sample.append(',');
                                sample.append(itemId(rs.get(0)));
                            }
                        }
                    }
                    return "{\"ok\":false,\"error\":\"配方书里没有 " + escape(target)
                        + "\",\"total\":" + total + ",\"sample\":\"" + escape(sample.toString()) + "\"}";
                }

                int containerId = p.containerMenu.containerId;

                // max=false 只摆一份材料。makeTool 必须先精确做 1 个工作台，
                // 否则「尽量摆满」会把 12 块木板全做成 3 个工作台，木棍就没材料了。
                boolean max = !raw.contains("\"max\":false");
                mc.gameMode.handlePlaceRecipe(containerId, found, max);

                return "{\"ok\":true,\"item\":\"" + escape(foundName) + "\",\"containerId\":" + containerId
                    + ",\"craftable\":" + craftable
                    + ",\"note\":\"已把材料摆进合成格，下一步取产物\"}";
            } catch (Throwable t) {
                return "{\"ok\":false,\"error\":\"" + escape(String.valueOf(t.getMessage())) + "\"}";
            }
        });
        respond(ex, body);
    }

    /**
     * 取走合成产物：对结果槽 shift 点击（等价于「一次合成全部」）。
     * 结果槽在玩家背包和合成台里都是 0 号。
     */
    /**
     * 抓一张当前画面（PNG）。
     *
     * 用途：把 AI 看到的画面投到外面的窗口里，玩家一边看 AI 干活、一边鼠标自由地用别的程序。
     *
     * 实现走原版 Screenshot.grab(mc, false)：它会异步写一张 PNG 到 screenshots 目录。
     * 26.3 的渲染 API 换成了 GuiGraphicsExtractor，没有直接拿 framebuffer 的公开方法，
     * 绕一圈读文件是最稳的（一张 1280x720 的 PNG 约 200KB，2fps 完全扛得住）。
     */
    private static void handleFrame(HttpExchange ex) throws IOException {
        readBody(ex);

        java.io.File dir = new java.io.File("screenshots");
        long before = System.currentTimeMillis();

        // 触发截图（必须在渲染线程）
        onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            net.minecraft.client.Screenshot.grab(mc, false);
            return "{}";
        });

        // 等文件落地（异步写盘，一般 50~200ms）
        java.io.File newest = null;
        for (int i = 0; i < 40; i++) {
            java.io.File[] files = dir.listFiles((d, n) -> n.toLowerCase().endsWith(".png"));
            if (files != null) {
                for (java.io.File f : files) {
                    if (f.lastModified() >= before - 500 && (newest == null || f.lastModified() > newest.lastModified())) {
                        newest = f;
                    }
                }
            }
            if (newest != null) break;
            try { Thread.sleep(50); } catch (InterruptedException ignored) { break; }
        }

        if (newest == null) {
            respondJson(ex, "{\"ok\":false,\"error\":\"截图没生成\"}");
            return;
        }

        // 文件是异步写的，刚出现时可能还是 0 字节——等它写完（大小稳定且大于 1KB）
        long lastSize = -1;
        for (int i = 0; i < 40; i++) {
            long len = newest.length();
            if (len > 1024 && len == lastSize) break;
            lastSize = len;
            try { Thread.sleep(50); } catch (InterruptedException ignored) { break; }
        }

        byte[] png = java.nio.file.Files.readAllBytes(newest.toPath());
        if (png.length < 1024) {
            respondJson(ex, "{\"ok\":false,\"error\":\"截图是空的\"}");
            return;
        }
        ex.getResponseHeaders().set("Content-Type", "image/png");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(200, png.length);
        try (java.io.OutputStream os = ex.getResponseBody()) {
            os.write(png);
        }
    }

    private static void respondJson(HttpExchange ex, String body) throws IOException {
        byte[] b = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(200, b.length);
        try (java.io.OutputStream os = ex.getResponseBody()) { os.write(b); }
    }

    private static void handleTake(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        final int times = Math.max(1, Math.min(10, (int) (num(raw, "times") == null ? 1 : num(raw, "times"))));

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            try {
                int containerId = p.containerMenu.containerId;
                ItemStack before = p.containerMenu.getSlot(0).getItem();
                String wantId = itemId(before);
                int beforeCount = countItemId(p, wantId);

                for (int i = 0; i < times; i++) {
                    mc.gameMode.handleContainerInput(containerId, 0, 0,
                        net.minecraft.world.inventory.ContainerInput.QUICK_MOVE, p);
                }
                return "{\"ok\":true,\"item\":\"" + escape(wantId) + "\",\"before\":" + beforeCount + "}";
            } catch (Throwable t) {
                return "{\"ok\":false,\"error\":\"" + escape(String.valueOf(t.getMessage())) + "\"}";
            }
        });
        respond(ex, body);
    }

    private static int countItemId(LocalPlayer p, String id) {
        int n = 0;
        for (int i = 0; i < p.getInventory().getContainerSize(); i++) {
            ItemStack st = p.getInventory().getItem(i);
            if (st != null && !st.isEmpty() && itemId(st).equals(id)) n += st.getCount();
        }
        return n;
    }

    private static void handleOptions(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String name = str(raw, "name");
        Double value = num(raw, "value");

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.player == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            net.minecraft.client.Options o = mc.options;

            if (name != null && value != null) {
                try {
                    switch (name) {
                        case "renderDistance" -> o.renderDistance().set((int) Math.max(2, Math.min(32, value)));
                        case "fov" -> o.fov().set((int) Math.max(30, Math.min(110, value)));
                        case "gamma" -> o.gamma().set(Math.max(0.0, Math.min(1.0, value)));
                        case "guiScale" -> o.guiScale().set((int) Math.max(1, Math.min(4, value)));
                        case "sensitivity" -> o.sensitivity().set(Math.max(0.0, Math.min(1.0, value)));
                        default -> {
                            return "{\"ok\":false,\"error\":\"不认识的设置项：\"}";
                        }
                    }
                } catch (Throwable t) {
                    return "{\"ok\":false,\"error\":\"" + escape(t.getMessage()) + "\"}";
                }
            }

            StringBuilder sb = new StringBuilder(256);
            sb.append("{\"ok\":true");
            sb.append(",\"renderDistance\":").append(o.renderDistance().get());
            sb.append(",\"fov\":").append(o.fov().get());
            sb.append(",\"gamma\":").append(String.format("%.2f", o.gamma().get()));
            sb.append(",\"guiScale\":").append(o.guiScale().get());
            sb.append(",\"sensitivity\":").append(String.format("%.2f", o.sensitivity().get()));
            sb.append(",\"difficulty\":\"").append(mc.level.getDifficulty().getSerializedName()).append('"');
            sb.append(",\"gamemode\":\"").append(mc.player.gameMode().getName()).append('"');
            sb.append('}');
            return sb.toString();
        });
        respond(ex, body);
    }

    /**
     * 修改单人世界规则。用户明确要求「死亡不掉落」，但当前世界关了作弊，
     * 聊天栏 /gamerule 用不了，所以直接调 IntegratedServer 的 GameRules。
     */
    private static void handleGameRule(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String name = str(raw, "name");
        String val = str(raw, "value");
        if (name == null || name.isBlank()) {
            respond(ex, "{\"ok\":false,\"error\":\"need name\"}");
            return;
        }
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            net.minecraft.client.server.IntegratedServer srv = mc.getSingleplayerServer();
            if (srv == null) return "{\"ok\":false,\"error\":\"当前不是单人世界\"}";
            if (!"keepInventory".equalsIgnoreCase(name)) {
                return "{\"ok\":false,\"error\":\"目前只支持 keepInventory\"}";
            }
            boolean on = !"false".equalsIgnoreCase(String.valueOf(val));
            srv.getGameRules().set(GameRules.KEEP_INVENTORY, on, srv);
            return "{\"ok\":true,\"name\":\"keepInventory\",\"value\":" + on + "}";
        });
        respond(ex, body);
    }

    /**
     * 存档管理：AI 要能自己开新世界/选存档，不能只靠用户点菜单。
     * 这些接口只走客户端自己的 LevelStorageSource，不碰世界存档文件格式。
     */
    private static void handleWorldList(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LevelStorageSource src = mc.getLevelSource();
            if (src == null) return "{\"ok\":false,\"error\":\"LevelStorageSource 不可用\"}";
            LevelStorageSource.LevelCandidates candidates = src.findLevelCandidates();
            List<LevelSummary> levels = null;
            String warning = "";
            try {
                levels = new ArrayList<>(src.loadLevelSummaries(candidates).get(2, TimeUnit.SECONDS));
                levels.sort((a, b) -> Long.compare(b.getLastPlayed(), a.getLastPlayed()));
            } catch (Throwable t) {
                // 某个损坏/被占用的存档会让整批 summary 失败；退回目录名，
                // 至少还能列出并进入其他存档。不要因为一个坏档把管理功能整个关死。
                warning = t.getClass().getSimpleName() + ": " + (t.getMessage() == null ? "" : t.getMessage());
                levels = new ArrayList<>();
            }

            StringBuilder sb = new StringBuilder(512);
            sb.append("{\"ok\":true");
            if (!warning.isEmpty()) sb.append(",\"warning\":\"").append(escape(warning)).append('"');
            sb.append(",\"levels\":[");
            if (levels.isEmpty()) {
                // 只给目录名：选存档够用，名字显示为文件夹名
                List<LevelStorageSource.LevelDirectory> dirs = candidates.levels();
                for (int i = 0; i < dirs.size(); i++) {
                    LevelStorageSource.LevelDirectory d = dirs.get(i);
                    if (i > 0) sb.append(',');
                    sb.append("{\"id\":\"").append(escape(d.directoryName())).append('"')
                      .append(",\"name\":\"").append(escape(d.directoryName())).append('"')
                      .append(",\"lastPlayed\":0,\"gamemode\":\"\",\"hardcore\":false")
                      .append(",\"commands\":false,\"compatible\":true,\"locked\":false}")
                      ;
                }
            } else {
                for (int i = 0; i < levels.size(); i++) {
                    LevelSummary s = levels.get(i);
                    if (i > 0) sb.append(',');
                    String gm = s.getGameMode() == null ? "" : s.getGameMode().getName();
                    sb.append("{\"id\":\"").append(escape(s.getLevelId())).append('"')
                      .append(",\"name\":\"").append(escape(s.getLevelName())).append('"')
                      .append(",\"lastPlayed\":").append(s.getLastPlayed())
                      .append(",\"gamemode\":\"").append(escape(gm)).append('"')
                      .append(",\"hardcore\":").append(s.isHardcore())
                      .append(",\"commands\":").append(s.hasCommands())
                      .append(",\"compatible\":").append(s.isCompatible())
                      .append(",\"locked\":").append(s.isLocked())
                      .append('}');
                }
            }
            sb.append("]}");
            return sb.toString();
        });
        respond(ex, body);
    }

    private static void handleWorldPlay(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String id = str(raw, "id");
        if (id == null || id.isBlank()) {
            respond(ex, "{\"ok\":false,\"error\":\"need id\"}");
            return;
        }
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level != null) {
                return "{\"ok\":false,\"error\":\"已经在世界里，先 /world/quit\"}";
            }
            if (!mc.getLevelSource().levelExists(id)) {
                return "{\"ok\":false,\"error\":\"没有这个存档: " + escape(id) + "\"}";
            }
            mc.createWorldOpenFlows().openWorld(id, () -> {});
            return "{\"ok\":true,\"id\":\"" + escape(id) + "\",\"started\":true}";
        });
        respond(ex, body);
    }

    /**
     * 打开/配置创建世界界面并点击「创建」。
     *
     * 第一次调用只负责 openFresh（界面初始化在客户端下一 tick），返回 retry=true；
     * Node 侧拿到 retry 后隔 1 秒再调一次，第二次才真正设置参数并点击。
     *
     * 单人世界默认强制 allowCommands=false：任务要求不用作弊，不能因为界面默认值
     * 或上一次操作留下「允许作弊」。
     */
    private static void handleWorldCreate(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level != null) {
                return "{\"ok\":false,\"error\":\"已经在世界里，先 /world/quit\"}";
            }

            net.minecraft.client.gui.screens.Screen sc = currentScreen();
            if (!(sc instanceof CreateWorldScreen screen)) {
                CreateWorldScreen.openFresh(mc, () -> {});
                return "{\"ok\":false,\"retry\":true,\"screen\":\"" + currentScreenName()
                    + "\",\"error\":\"已打开创建世界界面，稍后重试\"}";
            }

            String name = str(raw, "name");
            if (name == null || name.isBlank()) name = "AI-" + System.currentTimeMillis();
            name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (name.length() > 48) name = name.substring(0, 48);

            WorldCreationUiState ui = screen.getUiState();
            ui.setName(name);
            ui.setAllowCommands(false);
            ui.setGenerateStructures(true);
            ui.setBonusChest(false);

            String gm = str(raw, "gamemode");
            WorldCreationUiState.SelectedGameMode mode = WorldCreationUiState.SelectedGameMode.SURVIVAL;
            if (gm != null) {
                try {
                    mode = WorldCreationUiState.SelectedGameMode.valueOf(gm.toUpperCase());
                } catch (IllegalArgumentException ignore) { /* 非法值走生存 */ }
            }
            ui.setGameMode(mode);

            String diff = str(raw, "difficulty");
            Difficulty difficulty = Difficulty.NORMAL;
            if (diff != null) {
                try { difficulty = Difficulty.byName(diff.toLowerCase()); } catch (Throwable ignore) {}
                if (difficulty == null) difficulty = Difficulty.NORMAL;
            }
            ui.setDifficulty(difficulty);

            String seed = str(raw, "seed");
            if (seed == null) {
                Double n = num(raw, "seed");
                if (n != null) seed = String.valueOf(n.longValue());
            }
            if (seed != null) ui.setSeed(seed);

            AbstractWidget create = null;
            StringBuilder labels = new StringBuilder();
            for (net.minecraft.client.gui.components.events.GuiEventListener l : screen.children()) {
                if (!(l instanceof AbstractWidget w)) continue;
                String text;
                try { text = w.getMessage() == null ? "" : w.getMessage().getString(); }
                catch (Throwable t) { text = ""; }
                if (labels.length() < 300) {
                    if (labels.length() > 0) labels.append(" | ");
                    labels.append(text);
                }
                if (w.active && text.matches("(?i).*(create new world|create world|创建新的世界|创建世界).*")) {
                    create = w;
                    break;
                }
            }
            if (create == null) {
                return "{\"ok\":false,\"error\":\"没找到创建世界按钮\",\"labels\":\"" + escape(labels.toString()) + "\"}";
            }

            net.minecraft.client.input.MouseButtonEvent ev =
                new net.minecraft.client.input.MouseButtonEvent(
                    create.getX() + create.getWidth() / 2.0,
                    create.getY() + create.getHeight() / 2.0,
                    new net.minecraft.client.input.MouseButtonInfo(0, 0));
            create.onClick(ev, false);
            return "{\"ok\":true,\"name\":\"" + escape(name) + "\",\"gamemode\":\""
                + mode.name().toLowerCase() + "\",\"allowCommands\":false,\"clicked\":\"" + escape(create.getMessage().getString()) + "\"}";
        });
        respond(ex, body);
    }

    private static void handleWorldQuit(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level == null) {
                mc.setScreenAndShow(null);
                return "{\"ok\":true,\"inWorld\":false}";
            }
            mc.disconnectWithSavingScreen();
            return "{\"ok\":true,\"quitting\":true}";
        });
        respond(ex, body);
    }

    private static void handleGui(HttpExchange ex) throws IOException {
        readBody(ex);
        String body = onClientThread(() -> {
            net.minecraft.client.gui.screens.Screen sc = currentScreen();
            if (sc == null) return "{\"ok\":true,\"screen\":\"\",\"items\":[]}";

            StringBuilder sb = new StringBuilder(512);
            sb.append("{\"ok\":true,\"screen\":\"").append(sc.getClass().getSimpleName()).append('"');
            sb.append(",\"title\":\"").append(escape(sc.getTitle() == null ? "" : sc.getTitle().getString())).append('"');
            sb.append(",\"items\":[");
            int n = 0;
            for (net.minecraft.client.gui.components.events.GuiEventListener l : sc.children()) {
                if (!(l instanceof net.minecraft.client.gui.components.AbstractWidget w)) continue;
                if (n > 0) sb.append(',');
                String text = "";
                try { text = w.getMessage() == null ? "" : w.getMessage().getString(); } catch (Throwable ignore) {}
                sb.append("{\"i\":").append(n)
                  .append(",\"text\":\"").append(escape(text)).append('"')
                  .append(",\"x\":").append(w.getX())
                  .append(",\"y\":").append(w.getY())
                  .append(",\"w\":").append(w.getWidth())
                  .append(",\"h\":").append(w.getHeight())
                  .append(",\"active\":").append(w.active)
                  .append('}');
                n++;
            }
            sb.append("]}");
            return sb.toString();
        });
        respond(ex, body);
    }

    /**
     * 点界面元素：给 i（/gui 返回的序号）或给 x/y（屏幕坐标）。
     * 走 screen.mouseClicked + mouseReleased，等价于真的点一下，
     * 世界列表这类不是 AbstractWidget 的条目也能点（靠坐标）。
     */
    private static void handleClick(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double idx = num(raw, "i");
        Double cx = num(raw, "x");
        Double cy = num(raw, "y");

        if (idx == null && (cx == null || cy == null)) {
            respond(ex, "{\"ok\":false,\"error\":\"need i or x/y\"}");
            return;
        }

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            net.minecraft.client.gui.screens.Screen sc = currentScreen();
            if (sc == null) return "{\"ok\":false,\"error\":\"当前没有界面\"}";

            double px;
            double py;
            net.minecraft.client.gui.components.AbstractWidget hit = null;
            if (idx != null) {
                int want = idx.intValue();
                int n = 0;
                for (net.minecraft.client.gui.components.events.GuiEventListener l : sc.children()) {
                    if (!(l instanceof net.minecraft.client.gui.components.AbstractWidget w)) continue;
                    if (n == want) { hit = w; break; }
                    n++;
                }
                if (hit == null) return "{\"ok\":false,\"error\":\"没有第 " + want + " 个控件\"}";
                if (!hit.active) return "{\"ok\":false,\"error\":\"这个按钮是灰的\"}";
                px = hit.getX() + hit.getWidth() / 2.0;
                py = hit.getY() + hit.getHeight() / 2.0;
            } else {
                px = cx;
                py = cy;
            }

            net.minecraft.client.input.MouseButtonEvent ev =
                new net.minecraft.client.input.MouseButtonEvent(px, py,
                    new net.minecraft.client.input.MouseButtonInfo(0, 0));

            // 按序号点：直接调控件自己的 onClick，不经过 Screen 的命中测试。
            // 走 screen.mouseClicked 时它要重新算一遍「鼠标在哪个子控件上」，
            // 而我们的窗口不一定有真实鼠标焦点，经常点空。
            if (hit != null) {
                hit.onClick(ev, false);
            } else {
                sc.mouseClicked(ev, false);
                sc.mouseReleased(ev);
            }

            return "{\"ok\":true,\"x\":" + (int) px + ",\"y\":" + (int) py
                + ",\"screen\":\"" + currentScreenName() + "\"}";
        });
        respond(ex, body);
    }

    private static String currentScreenName() {
        net.minecraft.client.gui.screens.Screen sc = currentScreen();
        return sc == null ? "" : sc.getClass().getSimpleName();
    }

    private static void handleUi(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        String what = str(raw, "what");
        if (what == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need what\"}");
            return;
        }

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null || mc.level == null) return "{\"ok\":false,\"error\":\"not in world\"}";

            String w = what.toLowerCase();
            if (w.equals("close") || w.equals("none")) {
                // 只 setScreen(null) 不会发 ServerboundContainerClosePacket，
                // 服务端还认为容器开着，player.containerMenu 会残留 MerchantMenu，
                // 下一次 trade 就会对着一个没有界面的菜单操作（点击全部失败）。
                if (p.containerMenu != p.inventoryMenu) {
                    p.closeContainer();
                }
                mc.setScreenAndShow(null);
                lastUi = "";
                return "{\"ok\":true,\"screen\":\"\"}";
            }
            if (w.equals("inventory") || w.equals("bag")) {
                mc.setScreenAndShow(new InventoryScreen(p));
                lastUi = "InventoryScreen";
                return "{\"ok\":true,\"screen\":\"InventoryScreen\"}";
            }
            if (w.equals("chat")) {
                mc.setScreenAndShow(new ChatScreen("", false));
                lastUi = "ChatScreen";
                return "{\"ok\":true,\"screen\":\"ChatScreen\"}";
            }
            if (w.equals("respawn")) {
                mc.setScreenAndShow(null);
                p.respawn();
                lastUi = "";
                return "{\"ok\":true,\"screen\":\"\"}";
            }
            return "{\"ok\":false,\"error\":\"unknown ui\"}";
        });
        respond(ex, body);
    }

    private static void handleSelect(HttpExchange ex) throws IOException {
        String raw = readBody(ex);
        Double slot = num(raw, "slot");
        if (slot == null) {
            respond(ex, "{\"ok\":false,\"error\":\"need slot\"}");
            return;
        }
        int s = Math.max(0, Math.min(8, (int) Math.round(slot)));

        String body = onClientThread(() -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer p = mc.player;
            if (p == null) return "{\"ok\":false,\"error\":\"not in world\"}";
            p.getInventory().setSelectedSlot(s);
            return "{\"ok\":true,\"slot\":" + s + "}";
        });
        respond(ex, body);
    }

    // ---------------- helpers ----------------

    private static String capsJson() {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < CAPS.length; i++) {
            if (i > 0) sb.append(',');
            sb.append('"').append(CAPS[i]).append('"');
        }
        return sb.append(']').toString();
    }

    private static int dist2(Object[] o) {
        int dx = (Integer) o[0];
        int dy = (Integer) o[1];
        int dz = (Integer) o[2];
        return dx * dx + dy * dy + dz * dz;
    }

    private static String dimensionId(ClientLevel level) {
        try {
            return level.dimension().identifier().toString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    private static String blockId(ClientLevel level, BlockPos pos) {
        try {
            BlockState st = level.getBlockState(pos);
            return BuiltInRegistries.BLOCK.getKey(st.getBlock()).toString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    /** 附近 16 格内的生物/掉落物，最多 12 个。给模型「直接读数据」，不用它猜 */
    private static String entitiesJson(ClientLevel level, LocalPlayer p) {
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        try {
            // 同上：entitiesForRendering 只包含视锥内的实体，战斗/喂食会「看不见」背后的目标
            List<Entity> found = new ArrayList<>(level.getEntities(p, p.getBoundingBox().inflate(16.0), x -> true));
            found.sort((a, b) -> Double.compare(a.distanceTo(p), b.distanceTo(p)));
            for (Entity e : found) {
                if (e == p || !e.isAlive()) continue;
                double d = e.distanceTo(p);
                if (d > 16.0) continue;
                if (n > 0) sb.append(',');
                sb.append("{\"type\":\"").append(entityId(e)).append('"');
                sb.append(",\"eid\":").append(e.getId());
                sb.append(String.format(",\"dist\":%.1f", d));
                // 实体坐标必须带小数：整数化会让瞄准偏半格，村民/动物右键经常打空
                sb.append(String.format(",\"x\":%.2f,\"y\":%.2f,\"z\":%.2f", e.getX(), e.getY(), e.getZ()));
                if (e instanceof net.minecraft.world.entity.LivingEntity le) {
                    sb.append(String.format(",\"hp\":%.1f", le.getHealth()));
                    // 判断“该不该打”用游戏自己的归类，不靠 Node 正则
                    boolean hostile = e instanceof Enemy;
                    boolean neutral = e instanceof net.minecraft.world.entity.NeutralMob;
                    sb.append(",\"hostile\":").append(hostile);
                    sb.append(",\"neutral\":").append(neutral);
                    boolean threat = hostile && (d <= 12.0);
                    if (e instanceof Mob mob) {
                        net.minecraft.world.entity.LivingEntity target = mob.getTarget();
                        boolean targeting = target == p;
                        if (targeting) threat = true;   // 已经锁定玩家的怪，多远都算威胁
                        sb.append(",\"targeting\":").append(targeting);
                        sb.append(",\"hasTarget\":").append(target != null);
                    }
                    sb.append(",\"threat\":").append(threat);
                    sb.append(",\"los\":").append(p.hasLineOfSight(e));
                    if (e instanceof net.minecraft.world.entity.monster.Creeper creeper) {
                        sb.append(",\"swelling\":").append(creeper.getSwellDir() > 0);
                    }
                }
                if (e instanceof net.minecraft.world.entity.item.ItemEntity ie) {
                    // 掉落物要能看出是什么，否则 collect 只能盲目走到所有掉落物上
                    sb.append(",\"item\":\"").append(escape(itemId(ie.getItem()))).append('"');
                }
                sb.append('}');
                if (++n >= 12) break;
            }
        } catch (Throwable t) {
            return "[]";
        }
        return sb.append(']').toString();
    }

    private static String entityId(Entity e) {
        try {
            return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    private static String targetJson(Minecraft mc) {
        HitResult hit = mc.hitResult;
        if (hit == null) return "{\"type\":\"none\"}";
        if (hit instanceof EntityHitResult) {
            Entity e = ((EntityHitResult) hit).getEntity();
            return "{\"type\":\"entity\",\"id\":\"" + entityId(e) + "\",\"dist\":" + fmt(e.distanceTo(mc.player)) + "}";
        }
        if (hit instanceof BlockHitResult) {
            BlockHitResult bhr = (BlockHitResult) hit;
            BlockPos pos = bhr.getBlockPos();
            return "{\"type\":\"block\",\"id\":\"" + blockId(mc.level, pos) + "\",\"pos\":["
                + pos.getX() + "," + pos.getY() + "," + pos.getZ() + "],\"face\":\""
                + bhr.getDirection().getName() + "\",\"dist\":" + fmt(bhr.getLocation().distanceTo(mc.player.position())) + "}";
        }
        return "{\"type\":\"miss\"}";
    }

    /**
     * 整个背包（36 格 + 副手）按物品汇总。
     *
     * 之前只给了 hotbar 那 9 格，主背包里有什么模型完全看不到，
     * 于是「用背包里的木头做工作台」这种任务它根本不知道有没有木头。
     */
    private static String invJson(LocalPlayer p) {
        try {
            java.util.Map<String, Integer> counts = new java.util.LinkedHashMap<>();
            net.minecraft.world.entity.player.Inventory inv = p.getInventory();
            for (int i = 0; i < inv.getContainerSize(); i++) {
                ItemStack st = inv.getItem(i);
                if (st == null || st.isEmpty()) continue;
                counts.merge(itemId(st), st.getCount(), Integer::sum);
            }
            ItemStack off = p.getOffhandItem();
            if (off != null && !off.isEmpty()) counts.merge(itemId(off), off.getCount(), Integer::sum);

            StringBuilder sb = new StringBuilder("{");
            int n = 0;
            for (java.util.Map.Entry<String, Integer> e : counts.entrySet()) {
                if (n > 0) sb.append(',');
                sb.append('"').append(escape(e.getKey())).append("\":").append(e.getValue());
                if (++n >= 20) break;
            }
            return sb.append('}').toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    /**
     * 物品附魔 -> {"sharpness":5,...}。键去掉 minecraft: 前缀，便于模型读。
     */
    private static String enchantJson(ItemStack st) {
        try {
            net.minecraft.world.item.enchantment.ItemEnchantments ench = st.getEnchantments();
            if (ench == null || ench.isEmpty()) return "{}";
            StringBuilder sb = new StringBuilder("{");
            int n = 0;
            for (var entry : ench.entrySet()) {
                if (n++ > 0) sb.append(',');
                String id = entry.getKey().getRegisteredName();
                if (id.startsWith("minecraft:")) id = id.substring("minecraft:".length());
                sb.append('"').append(escape(id)).append("\":").append(entry.getIntValue());
            }
            return sb.append('}').toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    /** 某条附魔的等级；没有附魔返回 0。 */
    private static int enchantLevel(ItemStack st, String name) {
        try {
            net.minecraft.world.item.enchantment.ItemEnchantments ench = st.getEnchantments();
            if (ench == null || ench.isEmpty()) return 0;
            for (var entry : ench.entrySet()) {
                String id = entry.getKey().getRegisteredName();
                if (id.equals(name) || id.endsWith(":" + name)) return entry.getIntValue();
            }
        } catch (Throwable t) { /* ignore */ }
        return 0;
    }

    /** 单个槽位的详细物品：耐久/附魔也一起给 Node。 */
    private static String itemDetailJson(ItemStack st, int slot) {
        if (st == null || st.isEmpty()) return "null";
        StringBuilder sb = new StringBuilder("{");
        if (slot >= 0) sb.append("\"slot\":").append(slot).append(',');
        sb.append("\"id\":\"").append(escape(itemId(st))).append('"')
          .append(",\"count\":").append(st.getCount())
          .append(",\"damage\":").append(st.getDamageValue())
          .append(",\"maxDamage\":").append(st.getMaxDamage())
          .append(",\"ench\":").append(enchantJson(st))
          .append('}');
        return sb.toString();
    }

    /** 四件护甲的详情；保留原有 helmet/chest/... 字符串字段做兼容。 */
    private static String armorJson(LocalPlayer p) {
        StringBuilder sb = new StringBuilder("{");
        String[] names = { "boots", "leggings", "chest", "helmet" };
        for (int i = 0; i < names.length; i++) {
            if (i > 0) sb.append(',');
            sb.append('"').append(names[i]).append("\":")
              .append(itemDetailJson(armorStack(p, i), -1));
        }
        return sb.append('}').toString();
    }

    /** 背包 + 副手逐格详情（附魔/耐久），供识别带附魔的备用装备。 */
    private static String invItemsJson(LocalPlayer p) {
        StringBuilder sb = new StringBuilder("[");
        try {
            net.minecraft.world.entity.player.Inventory inv = p.getInventory();
            int n = 0;
            for (int i = 0; i < inv.getContainerSize(); i++) {
                ItemStack st = inv.getItem(i);
                if (st == null || st.isEmpty()) continue;
                if (n++ > 0) sb.append(',');
                sb.append(itemDetailJson(st, i));
            }
            ItemStack off = p.getOffhandItem();
            if (off != null && !off.isEmpty()) {
                if (n > 0) sb.append(',');
                sb.append(itemDetailJson(off, -1));
            }
        } catch (Throwable t) {
            return "[]";
        }
        return sb.append(']').toString();
    }

    private static ItemStack armorStack(LocalPlayer p, int armorIndex) {
        try {
            int slot = 5 + (3 - armorIndex);   // 5=头 6=胸 7=腿 8=靴
            return p.containerMenu.slots.get(slot).getItem();
        } catch (Throwable t) {
            return ItemStack.EMPTY;
        }
    }

    /**
     * 护甲槽：0=靴 1=腿 2=胸 3=头。
     * 26.3 里 Inventory 的 armor 字段不公开了，改从容器菜单读：
     * 玩家背包界面 5=头 6=胸 7=腿 8=靴。
     */
    private static String armorId(LocalPlayer p, int armorIndex) {
        ItemStack st = armorStack(p, armorIndex);
        return st == null || st.isEmpty() ? "" : itemId(st);
    }

    private static String handJson(LocalPlayer p) {
        try {
            ItemStack st = p.getInventory().getSelectedItem();
            if (st == null || st.isEmpty()) {
                return "{\"id\":\"air\",\"count\":0,\"slot\":" + p.getInventory().getSelectedSlot() + "}";
            }
            String detail = itemDetailJson(st, p.getInventory().getSelectedSlot());
            return detail;
        } catch (Throwable t) {
            return "{\"id\":\"unknown\",\"count\":0}";
        }
    }

    private static String hotbarJson(LocalPlayer p) {
        StringBuilder sb = new StringBuilder("[");
        try {
            List<ItemStack> items = p.getInventory().getNonEquipmentItems();
            for (int i = 0; i < 9 && i < items.size(); i++) {
                ItemStack st = items.get(i);
                if (i > 0) sb.append(',');
                if (st == null || st.isEmpty()) {
                    sb.append("\"air\"");
                } else {
                    sb.append('"').append(escape(itemId(st))).append('"');
                }
            }
        } catch (Throwable t) {
            return "[]";
        }
        return sb.append(']').toString();
    }

    private static String itemId(ItemStack st) {
        try {
            return BuiltInRegistries.ITEM.getKey(st.getItem()).toString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    private static String fmt(double v) {
        return String.format("%.2f", v);
    }

    /** 把任务丢到客户端线程执行并等结果 */
    private static String onClientThread(Supplier<String> task) {
        Minecraft mc = Minecraft.getInstance();
        CompletableFuture<String> future = new CompletableFuture<>();
        mc.execute(() -> {
            try {
                future.complete(task.get());
            } catch (Throwable t) {
                future.complete("{\"ok\":false,\"error\":\"" + escape(t.getMessage()) + "\"}");
            }
        });
        try {
            return future.get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"timeout waiting for client thread\"}";
        }
    }

    private interface Supplier<T> {
        T get() throws Exception;
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) return out;
        for (String pair : raw.split("&")) {
            int i = pair.indexOf('=');
            if (i <= 0) continue;
            out.put(pair.substring(0, i), pair.substring(i + 1));
        }
        return out;
    }

    private static int clampInt(String v, int def, int min, int max) {
        try {
            int n = Integer.parseInt(v);
            return Math.max(min, Math.min(max, n));
        } catch (Exception e) {
            return def;
        }
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream in = ex.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void respond(HttpExchange ex, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(200, bytes.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static Double num(String json, String field) {
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*(-?[0-9.]+)").matcher(json);
        return m.find() ? Double.parseDouble(m.group(1)) : null;
    }

    private static String str(String json, String field) {
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : null;
    }

    /** 解析 [x,y,z] */
    private static double[] parseTriplet(String json, String field) {
        Matcher m = Pattern.compile("\"" + field + "\"\\s*:\\s*\\[\\s*(-?[0-9.]+)\\s*,\\s*(-?[0-9.]+)\\s*,\\s*(-?[0-9.]+)\\s*\\]")
            .matcher(json);
        if (!m.find()) return null;
        return new double[] {
            Double.parseDouble(m.group(1)),
            Double.parseDouble(m.group(2)),
            Double.parseDouble(m.group(3)),
        };
    }

    /** 解析 [[x,y,z],...]，最多 max 个点。用括号配平找完整外层数组。 */
    private static double[] parsePoints(String json, String field, int max) {
        int key = json.indexOf("\"" + field + "\"");
        if (key < 0) return new double[0];
        int open = json.indexOf('[', key);
        if (open < 0) return new double[0];

        int depth = 0;
        int close = -1;
        for (int i = open; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '[') depth++;
            else if (c == ']') {
                depth--;
                if (depth == 0) { close = i; break; }
            }
        }
        if (close < 0) return new double[0];

        Matcher m = Pattern.compile("\\[\\s*(-?[0-9.]+)\\s*,\\s*(-?[0-9.]+)\\s*,\\s*(-?[0-9.]+)\\s*\\]")
            .matcher(json.substring(open, close + 1));
        java.util.List<Double> vals = new java.util.ArrayList<>();
        while (m.find() && vals.size() < max * 3) {
            vals.add(Double.parseDouble(m.group(1)));
            vals.add(Double.parseDouble(m.group(2)));
            vals.add(Double.parseDouble(m.group(3)));
        }
        double[] out = new double[vals.size()];
        for (int i = 0; i < vals.size(); i++) out[i] = vals.get(i);
        return out;
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }
}
