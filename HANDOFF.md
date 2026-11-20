# 交接文档 · 让 AI 玩《我的世界》

> 写给接手这个任务的 AI / 开发者。看完这一份就能上手，不用翻聊天记录。

---

## 0. 三十秒了解

**项目**：`AIBridge`（本机 AI 助手「爱丽丝」）—— Node 零依赖的 AI 网关 + Windows 桌面程序（Go + WebView2）。

**当前任务**：让 AI 在 **Minecraft 26.3** 里真正地玩——不是截屏 + 模拟鼠标，而是**进程内直接调用游戏 API**，把「砍树、合成、挖矿、打怪、交易」封装成确定性动作。

**进度**：核心生存链**已打通并回归**（砍树 → 木镐 → 向下挖，全程 AI 自主）。弓箭、竖井垫高、搭桥、村民交易、滑翔、重锤、近战都已实测通过。动作层 **50 个 case**：新增 `store` / `retrieve` / `smith` / `smeltBatch` / `plant` / `harvest` / `sleep` / `place`，以及 `task` 多阶段任务队列。反射层覆盖岩浆/水/低血/被围/悬崖/沙砾/苦力怕/TNT/氧气/工具耐久/断粮；决策层有 cost guard。`goto` 已升级为「绕行 → 搭桥/垫高 → 挖掘 → 具体失败原因」。另有一套**纯客户端可视化**：Node 推 `/visualize`，mod 画路径流光、目标框、光柱、历史轨迹，以及左上角常驻状态卡片（当前工作/动作/目标/进度）。全局寻路已接 **Baritone 1.20.0**（26.3 Fabric）：`goto` 长距离自动交给 Baritone，未安装或失败时回退本地策略。动作层还会**自动换工具/武器**（按原版工具规则、按攻击伤害与攻速），反射层会**自动反击有威胁的敌对生物**（不碰中立/被动生物，苦力怕仍走后退逻辑）；防御分 `passive`/`counter`/`active`，安全时自动换护甲和盾。

**当前状态**：8787 网关已运行；游戏未启动（8788 无响应），按第 3 节重启即可。

> 2026-11-08 修复记录：弓箭改 Mixin；合成输入改 KeyMapping 注入；实体查询改 AABB；交易/攻击/滑翔/搭桥改确定性接口；修了负坐标取整、假成功、失焦暂停、容器残留等 10 余个问题。第二批新增背包管理/农业/批量烧炼/睡眠 + cost guard。详见第 7、8 节。

---

## 1. 环境与硬约束

| 项 | 值 |
|---|---|
| 项目根目录 | `D:\AI\女儿`（**路径含中文，这是个坑，见 9.6**） |
| Node | ≥ 18，核心零第三方依赖 |
| JDK | **必须 25+**（MC 26.3 的 class 文件版本是 69，JDK 21 会报「错误的版本 69.0，应为 65.0」） |
| 本机 JDK 路径 | `C:\Program Files\Microsoft\jdk-25.0.5.21-hotspot` |
| 游戏版本 | 26.3，Fabric 加载，客户端在 `runtime/mc/` |
| 网关端口 | **8787** |
| mod 控制端口 | **8788**（两个不是一回事，见 9.1） |

**铁律**

1. `data/config.json` 是用户真实配置（含 API 密钥、QQ 号）。**任何测试都不许拿它当草稿纸**。测试走 `tests/_guard.js` 的 `snapshot()/restore()`。
2. 不要动 `.workbuddy-ai/` 目录（项目记忆）。
3. 代码风格：中文注释、注释写「为什么」不写「做了什么」、不引入 jsdom/axios/express 这类依赖。
4. **改完 Java 必须重新构建 + 重启游戏**——mod 是启动时加载的，热改无效。

---

## 2. 文件地图

| 路径 | 行数 | 职责 |
|---|---|---|
| `lib/game/engine.js` | 4531 | **核心**。动作分发（50 个 case）、任务队列、反射层、cost guard、agent 循环 |
| `lib/mc/agent.js` | 218 | mod HTTP 接口的 JS 封装（`state/blocks/move/mine/interact/hit/...`） |
| `lib/mc/wiki.js` | 202 | mcmod 百科查询（本地索引 + 在线搜索） |
| `lib/mc/launcher.js` | 469 | 启动游戏、优先 Fabric mod、正版登录 |
| `mcmod/src/main/java/com/aibridge/mcmod/BaritonePathing.java` | 112 | 可选 Baritone 全局寻路桥（GoalXZ/GoalNear/status/cancel） |
| `mcmod/src/main/java/com/aibridge/mcmod/ControlServer.java` | 2639 | **mod 主体**，39 个 HTTP 接口，直接调游戏内部 API |
| `mcmod/src/main/java/com/aibridge/mcmod/mixin/KeyMappingMixin.java` | 48 | **Mixin**：把合成按键叠加到 `KeyMapping.isDown()` |
| `mcmod/src/main/java/com/aibridge/mcmod/SyntheticInput.java` | 78 | 合成输入状态（移动/跳跃/右键） |
| `mcmod/src/main/java/com/aibridge/mcmod/VisualizationState.java` | 78 | Node 下发的可视化快照（volatile） |
| `mcmod/src/main/java/com/aibridge/mcmod/VisualizationRenderer.java` | 298 | 客户端渲染：粒子/目标框/光柱/轨迹/常驻卡片 |
| `mcmod/build.js` | 318 | 构建 mod：`node mcmod/build.js`（递归编译 + 打包资源） |
| `server.js` | 1258 | 网关，含 `/api/mc/*`、`/api/game/*` |
| `data/mc-item-index.json` | — | mcmod 879 条词条索引（缓存 7 天） |

**engine.js 里的关键位置**

| 行号 | 内容 |
|---|---|
| 1897 | `execAgentAction(a)` —— **唯一的动作入口**，加动作就在这里的 `switch` |
| 3797 | `loopAgent()` —— 主循环：读状态 → 决策 → 执行 → 写 history |
| 666 | `buildAgentPrompt()` —— 拼给模型的提示词（动作表 + 任务进度） |
| 262 | `runReflex()` —— 反射层（岩浆/水/被围/悬崖/沙砾/苦力怕/TNT/氧气/耐久/断粮） |
| 1790 | `runTaskStep()` —— 多阶段任务队列的单步执行器 |
| 1414 | `armorScore()` / `equipBestArmor()` —— 被动防御换甲/盾 |
| 1322 | `baritoneGotoPath()` —— Baritone 全局寻路 + 到达/超时/死亡处理 |
| 1554 | `categoryOf()` + `openNearbyBlock()` —— cost guard 分类 / 开容器 |
| 1201 | `ensureInHotbar()` —— 把物品从背包挪到快捷栏 |
| 1535 | `ensureAlive()` —— 死亡自动重生（尸体状态世界不推进） |
| 4297 | `start()` —— 启动入口 |

---

## 3. 怎么跑起来

### 3.1 启动网关

```bash
cd "D:/AI/女儿" && node server.js
# 后台跑：run_in_background
```

确认：`curl --noproxy '*' -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/status` → 200

### 3.2 构建 mod（改了 Java 才需要）

```bash
cd "D:/AI/女儿" && timeout 180 node mcmod/build.js
```

产物有两个：`lib/mc/aibridge-agent.jar`（javaagent 备用）和 `runtime/mc/game/mods/aibridge-1.0.0.jar`（Fabric mod，启动器优先）。构建会递归编译 `mcmod/src/main/java`（含 mixin 子包）并把 `src/main/resources` 全部打进 mod jar——新增资源（如 `aibridge.mixins.json`）不用改 build.js。

### 3.3 启动游戏

```bash
curl -s --noproxy '*' -X POST -H "Content-Type: application/json" -d '{}' \
  http://127.0.0.1:8787/api/mc/launch
```

**等 33 秒左右**（实测值），然后确认：`tasklist //NH | grep -c java` 应为 1。

### 3.4 进世界（点主菜单）

```bash
C() { curl -s --noproxy '*' -X POST -H "Content-Type: application/json" -d "$1" http://127.0.0.1:8788/click; }
C '{"i":0}'            # 单人游戏
sleep 2
C '{"x":213,"y":61}'   # 选第一个存档（坐标写死，屏幕分辨率变了要重算）
sleep 2
C '{"i":3}'            # 进入
sleep 16
curl -s --noproxy '*' http://127.0.0.1:8788/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('inWorld:',j.inWorld,'血:',j.health,'y:',Math.round(j.y));});"
```

### 3.5 直接执行动作（**最重要的调试手段**）

跳过模型，直接跑一个动作：

```bash
curl -s --noproxy '*' -X POST -H "Content-Type: application/json" \
  -d '{"action":"goto","x":-8,"z":16,"range":1.5,"ms":15000}' \
  http://127.0.0.1:8787/api/game/act
```

模型路径（完整 agent 循环）：

```bash
curl -s --noproxy '*' -X POST -H "Content-Type: application/json" \
  -d '{"title":"Minecraft 26.3","goal":"砍木头做木镐，然后挖石头拿圆石","maxRounds":10,"dryRun":false,"mode":"agent"}' \
  http://127.0.0.1:8787/api/game/start

curl -s --noproxy '*' http://127.0.0.1:8787/api/game/status   # 看 history
```

### 3.6 给测试物品 / 召唤生物

```bash
curl -s --noproxy '*' -X POST -H "Content-Type: application/json" \
  -d '{"text":"/give @p minecraft:bow 1"}' http://127.0.0.1:8788/chat
```

---

## 4. 架构与数据流

```
        ┌──────────────────────────────┐
模型 ◄──┤ loopAgent (engine.js:3663)   │
        │  读 state → 拼 prompt → 决策  │
        │  → execAgentAction × N       │
        └──────────┬───────────────────┘
                   │ HTTP (lib/mc/agent.js)
                   ▼
        ┌──────────────────────────────┐        ┌─────────────────────────┐
        │ Fabric mod :8788             │  goto  │ Baritone 1.20.0（可选）  │
        │ ControlServer.java           ├───────►│ GoalXZ / GoalNear       │
        │ 直接调 Minecraft 内部 API     │        │ A* 全局路径              │
        └──────────┬───────────────────┘        └─────────────────────────┘
                   │ /visualize（动作/路径/目标/进度）
                   ▼
        ┌──────────────────────────────┐
        │ VisualizationRenderer（客户端）│
        │ 粒子 / 目标框 / 光柱 / 轨迹 / 卡片 │
        └──────────────────────────────┘
```

**要点**

- 动作是**确定性封装**，不是让模型一步步摸索。模型只负责「选哪个动作、参数是什么」。
- 一次决策可以返回 `{"actions":[...]}`，最多 8 个顺序执行（避免一步一停）。
- 三种模式：`agent`（进程内直连，默认）、`menu`（点菜单）、视觉（截图 + 视觉模型，已默认关闭，慢且不稳）。
- 死亡自动复活：循环每轮检查 `world.dead`，自动 `ui('respawn')`。

**mod 的 39 个接口**

```
/state /blocks /look /move /use /usehold /key /keyhold /inputdebug
/chat /attack /mine /container /slot /servers /craft /frame /take
/options /gui /click /ui /select
/pillar /bridge /place /trades /resume /interact /glide /hit /stop /visualize
/besttool /bestweapon /bestarmor /baritone/goto /baritone/status /baritone/stop
```

`/state` 额外返回 `armor`（四槽物品详情）、`hand.ench`、`invItems`（逐格物品详情，含 `ench`/`damage`/`maxDamage`）和实体的 `threat` 字段，供模型识别附魔装备与威胁。

战斗/交互类新增的都是「按实体 id 直接调游戏 API」，不依赖准星：
`/interact {type}` 右键实体、`/hit {type}` 攻击实体、`/glide` 展开鞘翅。

---

## 5. 已实现的 50 个动作

| 类别 | 动作 |
|---|---|
| 观察 | `look` `lookAt` `turn` `state` `blocks` `container` `gui` |
| 移动 | `walk` `goto` `move` `hold` `key` |
| 垂直/跨越 | `pillar` `bridge` `digDown` |
| 建筑 | `place` |
| 挖掘 | `mine` `chop` `collect` |
| 合成/加工 | `craft` `smith` `makeTool` `smelt` `smeltBatch` `smeltCheck` |
| 储存 | `store` `retrieve` |
| 农业 | `plant` `harvest` |
| 任务 | `task` `taskStatus` `taskResume` `taskCancel` `wait` |
| 交互 | `use` `attack` `click` `slot` `select` `open` `chat` `server` `set` `resume` `sleep` |
| 战斗/生物 | `fight` `hunt` `feed` `trade` |
| 特殊物品 | `equip` `glide` `smash` `shoot` |
| 知识 | `wiki` |

**高层动作的实现思路**（都是「找目标 → 走近 → 对准/直接调 API → 执行 → 校验结果」）

- `chop`：优先挖**最低的原木**；坐标必须用 `Math.floor`（负坐标下 `Math.round` 会偏一格，挖到隔壁空气）
- `collect`：chop → 找匹配的掉落物实体 → 瞬移到掉落物（`/move`）→ 数背包；收不够返回失败
- `makeTool`：先 `craft` 木板 → **只做 1 个工作台**（`max:false`）→ 只做 1 份木棍 → 放工作台 → 做工具
- `digDown`：先把自己挪到最近支撑方块正上方（防止站在 1x1 洞边缘），每挖一层校验 y 是否下降
- `fight`：找最近敌对生物 → 走近 → `/hit` 按实体 id 攻击（不依赖准星）→ 等服务端同步血量再判断命中
- `feed`：自动选食物 → 挪到快捷栏 → `/interact` 右键实体 → 用食物数量是否减少判断成功
- `trade`：`/interact` 打开村民 → `/trades` 读真实报价 → 选能负担的一档 → 点报价 → 左键结果槽 → 放进背包空格 → 关闭界面退料
- `shoot`：`/usehold` 按住右键蓄力（Mixin 保状态）→ release → 校验蓄力时长和箭数
- `glide`：`/glide` 直接调 `tryToStartFallFlying` 并补发 START_FALL_FLYING 包
- `smash`：走近目标 → 跳 → `/hit`，按下落加成结算，校验血量
- `pillar`：tick 状态机「跳 → 在脚下侧面放方块 → 落上去」
- `bridge`：站在实心方块上 → 贴侧面放一块 → 走半步 → 循环
- `place`：找目标相邻的实心方块当支撑 → 直接发 `useItemOn`（不靠准星）
- `task`：模型一次给 `steps`，动作层逐步自动执行；失败暂停、`taskResume` 继续、`taskCancel` 放弃
- `goto`：卡住后依次「重瞄 → 边走边跳 → 左右绕行 → 搭桥/垫高/挖开 → 报具体障碍（前方方块+落差+高差）」
- **Baritone 全局寻路**：`goto` 在 `game.pathfinder` 为 `auto`（默认）且直线距离 >10 格时先调 `/baritone/goto`，轮询 `/baritone/status` 直到到达/超时；Baritone 未安装、路径失败或超时会 `baritoneStop` 并回退本地 `goto`。`pathfinder:"local"` 或 `"baritone":false` 可关闭；`pathfinder:"baritone"` 则所有距离都优先交给 Baritone。实际路径会写进 `state.vizTrail`，客户端卡片显示「Baritone 自动寻路（剩余 N 格）」。
- `smith`：找/放/开工作台 → `craft`（默认一份，`max:true` 清材料）
- `smeltBatch`：找熔炉 → 燃料 shift 进 1 号槽 → 输入右键放 N 个 → 等产物 → shift 取走
- `store` / `retrieve`：找箱子 → shift 整堆存/取 → 用背包数量变化校验
- `plant`：种子拿在手上 → 找耕地 → 走近 → 右键；`harvest`：扫作物 → 挖 → 瞬移捡掉落物
- `sleep`：找床 → 瞄低（床只有半格高）→ 右键 → 查 `state.sleeping`
- 反射层：岩浆/水/低血吃/被围（3 只 5 格内 + 血<12 → 垫高后撤）/悬崖/沙砾/苦力怕/TNT/缺氧/工具耐久/断粮/卡住
- **自动换工具**：`mine` 前调 `/besttool`，Java 侧用 `isCorrectToolForDrops` + `getDestroySpeed` + `efficiency` 附魔等级给全背包物品打分；主背包里的最佳工具只在快捷栏有空槽时挪进去，快捷栏满则退回当前快捷栏最佳工具
- **自动换武器**：`attack`（准星在实体上）/ `fight` / `hunt` 前调 `/bestweapon`，按 `ATTACK_DAMAGE × (4 + ATTACK_SPEED 修饰符)` + `sharpness` 估 DPS，没有比空手更高就不换
- **自动换护甲**：安全时调 `/bestarmor`，按护甲材料 + 保护类附魔给四槽推荐备用件；Node 侧逐个 `equip` 并回读 `/state` 校验
- **自动反击**：反射层用 `/state.entities` 的 `hostile`（Java `Enemy`）、`neutral`（`NeutralMob`）、`targeting`（目标是玩家）、`los` 判断；默认 `defenseMode:"counter"`：攻击正在追玩家或已进入 4.5 格的敌对生物，或用 `lastAttacker.eid` 锁定刚打你的远程怪；中立生物只有被激怒/锁定玩家才打；苦力怕继续走“靠近就后退”的专用逻辑
- **主动防御**：`defenseMode:"active"` 把交战半径扩到 `defenseRange`（默认 12，夹在 4~24；有视线、敌对即可），主动清掉附近威胁；`"passive"` 不主动接战，只在被锁定/血量≤10/敌人≤4.5 格时后撤；`"off"` 关闭自动反击
- **被动防御**：安全时（无 6 格内敌对、血>10、无界面）自动换更好的四件护甲，并把盾牌放进副手；胸甲槽是鞘翅时保留鞘翅不换。`autoArmor:false` 可关闭
- **精确攻击**：`/hit` 增加 `eid`，自动反击/`fight`/`smash` 锁定具体实体，避免同类型怪里打错人
- **容器安全**：`ensureInHotbar` 只往空槽放，快捷栏满就放弃搬运；不再用“换到已占用槽”的方式，避免光标物品在关闭背包时丢失
- `/state` 防御字段：`helmet/chest/leggings/boots/offhand/blocking/lastAttacker`；`lastAttacker` 由 `getLastHurtByMob()` 读出
- 危险感知字段在 `/state`：`front` `frontDrop` `unstableAbove` `air` `maxAir` `handDamage` `handMaxDamage`
- 工具耐久 <15%：有备用自动换；没有就暂停任务并提示「该做新工具了」
- 饥饿 <6 且没食物：暂停任务，提示先找动物/作物
- cost guard：连续 5 轮同类动作 → 提示词警告并切到云端规划模型（`plannerProviderId` 可选）

---

## 6. 已实测通过（有数据）

### 6.1 完整生存链（2026-11-08 回归）

```
collect dark_oak_log   → 7 个（目标 3）
makeTool               → wooden_pickaxe ×1（剩余木板 23 / 木棍 2 / 工作台 2）
digDown to 74          → y 79 → 74，共 4 层
```

**动作链由引擎确定性执行，无人工干预。**

### 6.2 单项（2026-11-08 实测）

| 功能 | 结果 |
|---|---|
| `shoot` | 蓄力 1200ms，箭 16→15 ✅ |
| `pillar` | y=100 → 103，消耗 3 个泥土 ✅ |
| `bridge` | x=-11.5 → -14.6，搭 3 格，未掉落 ✅ |
| `trade` | carrot×22 → emerald×1，背包按预期变化 ✅ |
| `glide` | `flying=true`，`/glide {"stop":true}` 可收 ✅ |
| `smash` | 重锤命中 husk，伤害 6.2 击杀 ✅ |
| `fight` | 8 下打死 husk ✅ |
| `collect`（修负坐标后） | 砍 7 根原木并全部捡起 ✅ |
| `goto`（合成输入修复后） | 10 格内可正常到达，1 格台阶会边走边跳 ✅ |
| 全部本地测试 | 12 个脚本全绿，约 300 项 ✅ |

### 6.3 第二批高阶动作（2026-11-08 实测）

| 功能 | 结果 |
|---|---|
| `store` | 圆石 64→0，箱子内 64 ✅ |
| `retrieve` | 圆石 0→64 ✅ |
| `smith` | 默认一份（显式 `max:true` 才批量）✅ |
| `smeltBatch` | 3 个铁矿石 → 3 个铁锭，约 32 秒 ✅ |
| `plant` | 小麦种子 8→6，耕地上出现 2 株小麦 ✅ |
| `harvest` | 收 2 株，种子 6→8（未成熟只掉种子）✅ |
| `sleep` | 夜晚放置床后 `sleeping=true` ✅ |
| `place` | (2,90,23)/(3,90,23) 等坐标放置成功；已存在的返回 `already` ✅ |
| `task` | 3 步队列（place→place→collect）自动执行到 index=3 ✅ |
| `task` 预检 | place y=999 → 拒绝排队「超出世界高度」✅ |
| `task` fallback | 主步骤 store 失败 → fallback collect 成功，`usedFallback:true` ✅ |
| `task` 恢复 | 反射暂停后移动玩家 → `taskResume` 返回「背包/高度已变，建议预检」✅ |
| `goto` 清障 | 3 格石墙可绕/挖过去；bedrock 墙返回「前方是 minecraft:bedrock」✅ |
| `goto` 失败缓存 | 代码就绪（10 分钟 TTL，最多 100 条）；未做真实二次踩坑回归 |
| 危险反射 | TNT 1.1 格 → `reflex:tnt` ✅；悬崖/沙砾/耐久 7%/断粮用构造状态验证返回对应 reflex ✅；苦力怕/缺氧/沙砾冲刺未做真实场景回归 |
| `hunt` | 牛 1 血时补刀成功，拾取 beef×3 / leather×2 ✅ |
| `/stop` | 按住 W 时调用，位置停止变化 ✅ |
| `smeltBatch` | 立即返回 pending；`smeltCheck` 先 pending，6 秒后收 2 个铁锭 ✅ |
| JSONL 日志 | `data/mc-sessions/*.jsonl` 生成；回放脚本输出动作分布/失败/最近记录 ✅ |
| `/visualize` | 3 点路径解析成功、target=true；游戏截图可见目标框、路径线、光柱、HUD 状态/进度条 ✅ |
| 常驻卡片 | 截图可见左上角半透明卡片：标题、动作标签、状态、目标坐标/距离、进度条；空闲时显示「待命/等待指令」；`hud:false` 时卡片仍在 ✅ |
| 卡片清空 | 推空状态后世界内特效消失，卡片回到「待命 / 等待指令」；`stop()` / 轮数结束会调用 `clearVisualize()` ✅ |
| 可视化注册 | 日志出现「可视化渲染已注册」，无渲染异常 ✅ |

### 6.4 自动工具 / 自动防御（2026-11-08 / 2026-11-14 实测）

| 功能 | 结果 |
|---|---|
| `/besttool` 背包工具 | 原木 + 背包铁斧 → `inInventory:true, correct:true`；`mine` 自动挪到空槽并返回「自动换 iron_axe」✅ |
| `/besttool` 空槽搬运 | 下界合金镐在背包、快捷栏有空位 → 自动进空槽并选中，剑/斧数量不变 ✅ |
| `/besttool` 快捷栏满 | 下界合金镐在背包、快捷栏满 → 回退快捷栏木镐，石头照常挖掉，背包镐未丢失 ✅ |
| `/bestweapon` | 铁剑 dps=9.60；下界合金剑优先于斧；自动选中并攻击 ✅ |
| `/bestweapon` 空槽搬运 | 下界合金剑在背包、空槽 1 格 → 自动进空槽并选中，斧/镐数量不变 ✅ |
| `/besttool` 效率附魔 | 背包木质镐效率 5 → 压过无附魔下界合金镐被选中，返回 `ench:{"efficiency":5}` ✅ |
| `/bestweapon` 锋利附魔 | 背包钻石剑锋利 5 → dps=16.00，压过无附魔下界合金剑，返回 `ench:{"sharpness":5}` ✅ |
| `/bestarmor` 附魔换甲 | 当前无附魔钻石头盔、背包保护 4+耐久 3 钻石头盔 → 推荐 `invSlot`，`equipBestArmor` 换上后 `armor.helmet.ench` 为 `{protection:4,unbreaking:3}` ✅ |
| 自动反击 | 2 格僵尸 → `reflex:defend`，自动选下界合金剑，20 → 10.5 HP ✅ |
| 被动防御（护甲） | 头盔/腿/靴空、胸甲是鞘翅、副手空 → 自动换 diamond_helmet/leggings/boots + shield；鞘翅保留 ✅ |
| 被动防御（后撤） | passive 模式，2.9 格僵尸 → `reflex:retreat` 后撤 ✅ |
| 主动防御 | active 模式，6.1 格未锁定僵尸 → `reflex:defend_approach` 主动接近 ✅ |
| 反击优先目标 | counter 模式，`lastAttacker` 指向 10.4 格僵尸 → 优先接近该 eid ✅ |
| 中立/被动不攻击 | 3.7 格牛 → `hostile:false, neutral:false`，`runReflex` 返回 null ✅ |
| 敌我字段 | `/state.entities` 带 `hostile/neutral/targeting/los`，按距离排序，最近 12 个 ✅ |
| 精确 eid | `/hit {eid}` 锁定具体实体，自动反击不会打到旁边的同类型怪 ✅ |
| 物品保留 | 空槽搬运后自动检查 `inv` 数量：剑/斧/镐均保持原数量 ✅ |

### 6.5 Baritone 全局寻路（2026-11-13 实测）

| 功能 | 结果 |
|---|---|
| Baritone 加载 | `runtime/mc/game/mods/baritone-api-fabric-1.20.0.jar` 被 Fabric 加载，日志出现 `baritone 1.20.0` ✅ |
| `/baritone/status` | `available:true`；路径中 `pathing:true, hasPath:true, goal:"GoalXZ{x=30,z=50}", path:50` ✅ |
| `/baritone/goto` | 设定 `GoalXZ{30,50}` 后玩家从 (1.5,90,22.5) 移动到 (17.2,88,23.5)，路径生效 ✅ |
| `/baritone/stop` | 状态回到 `pathing:false, hasPath:false`，玩家停止 ✅ |
| Node `goto` 接管 | 从 (31,49) 到 (55,55) 约 7.1 秒返回「Baritone 到达（剩余 2.1 格）」，玩家实际到达 (53.7,70,56.5) ✅ |
| 短距离回退本地 | 2~3 格 `goto` 不走 Baritone，本地返回「到了（还差 0.3 格）」✅ |
| 死亡保护 | 寻路中发现 `state.dead` → `baritoneStop` 并返回 fatal，不再继续跑尸；代码路径已加，未做完整重跑尸实测 |
| 未安装降级 | 拔掉 Baritone jar 启动：AIBridge 正常加载，`/baritone/status` 返回 `available:false`，长距离 `goto` 回退本地并返回本地失败原因，不崩 ✅ |
| 路径可视化 | `/baritone/status.path` 会写入 `state.vizTrail`，客户端卡片显示「Baritone 自动寻路（剩余 N 格）」；截图验证过状态卡片 ✅ |

---

## 7. 已修复 / 剩余问题

### 7.1 本轮已修复（都有实测）

| 问题 | 根因 | 修法 |
|---|---|---|
| `shoot` 拉弓状态保不住 | `handleKeybinds` 每帧按 `keyUse.isDown()` 松手；`KeyMapping.setAll()` 覆盖 setDown | `SyntheticInput` + `KeyMappingMixin` 在 `isDown()` 返回值上叠加；`/usehold` 按住/释放；校验 `chargedTicks` 和箭数 |
| 走路/跳跃「看起来动了」 | 26.3 的 `KeyboardInput.tick()` 每 tick 用 `KeyMapping.isDown()` **重建** `input.keyPresses`，直接写 keyPresses 下一 tick 就被覆盖 | 所有移动/跳跃/右键统一走 `SyntheticInput`，由 Mixin 注入 `isDown()` |
| `collect` 砍了但捡不到 | 负坐标 `Math.round` 偏一格，挖到隔壁空气；掉落物不自动吸 | 改 `Math.floor`；掉落物实体显示 `item` id；`collect` 瞬移到匹配掉落物并数背包 |
| `collect` / `mine` / `digDown` 假成功 | 底层返回 `ok:true` 但 `broken:false`；`digDown` 有 danger 仍返回 ok | 底层返回真实 `broken`；`digDown` 有 danger/未下降返回失败 |
| `makeTool` 木板被吃光 | `handlePlaceRecipe(..., true)` 摆满材料，shift 取产物一次做出 3 个工作台 | `craft` 增加 `max` 参数；makeTool 的工作台/木棍/工具都用 `max:false` |
| `trade` 假成功 | 只点报价不点结果槽；普通左键产物在鼠标上；shift 点结果会一次换很多 | `/trades` 读真实报价；左键结果 → 左键背包空格；关闭容器退料 |
| `trade` 打不开 | 树冠挡视线，`use` 射线打到方块 | `/interact {type}` 直接按实体 id 调 `gameMode.interact` |
| 战斗/喂食打空 | 准星瞄准用旧坐标，怪一动就偏；`entitiesForRendering` 只包含视锥内实体 | `/hit {type}` 直接攻击；实体查询改 AABB `level.getEntities`；实体坐标保留小数 |
| `glide` 展不开 | 合成跳跃触发不了 `tryToStartFallFlying`，jumpTriggerTime 还会干扰 | `/glide` 直接调 `tryToStartFallFlying` + 补发 `START_FALL_FLYING` 包 |
| 失焦自动暂停 | `onInitializeClient` 时 `Minecraft.options` 还是 null，设置没生效 | 第一个 client tick 设置 `pauseOnLostFocus=false`；`/resume` 兜底 |
| 容器关不干净 | 只 `setScreen(null)` 不发关闭包，`containerMenu` 残留 | `/ui close` 调 `p.closeContainer()` |
| `craft` 已有物品时假成功 | 只判断合成后数量 >0，背包里本来就有该物品时失败也报成功 | 记录合成前后数量，必须增加才算成功 |
| 一步一决策，长任务 token 贵 | 每个动作都要问模型 | `task` 队列：一次给 steps，动作层自动执行；失败暂停、`taskResume` 继续、`taskCancel` 放弃 |
| `goto` 遇墙/沟只会卡住 | 只有直线走 + 跳 | 五级：重瞄 → w+jump → 左右绕行 → 搭桥/垫高/挖开 → 返回前方方块/落差/高差 |
| 危险只感知岩浆/水 | 悬崖、沙砾、苦力怕、TNT、缺氧都靠模型发现 | `/state` 增加 `front`/`frontDrop`/`unstableAbove`/`air`/`maxAir`；反射层逐条处理 |
| 工具快坏/断粮没人管 | 模型经常挖到工具碎 | 耐久 <15% 自动换备用或暂停任务提示；饥饿<6 且没食物暂停任务提示找动物/作物 |
| 悬崖只暂停不刹车 | 惯性/持续按键下一 tick 还会走 | `/stop` 清空 SyntheticInput 和 keyPresses，再暂停任务 |
| 沙砾前停下会被埋 | 统一「提示+暂停」是反效果 | `reflex:falling_run` 改为冲刺离开 |
| 任务一步失败全停 | 局部可修复的失败也中断 | 每步 `fallback` 数组 + 排队前预检（缺材料/坐标） |
| 工具/断粮永久卡住 | 无人值守时只提示不行动 | `reflexAutoResolve: off|try|force`；try 自动做工具/狩猎，force 还会探索 |
| 反射暂停后任务坐标失真 | 恢复时不知道世界变了 | 暂停记录坐标/背包快照；`taskResume` 返回变化警告 |
| `smeltBatch` 阻塞反射 | 同步等 30~100 秒，期间 TNT/苦力怕无法处理 | 改为启动返回 pending，`smeltCheck` 下一轮收产物 |
| 没有落盘日志 | 47+ 动作靠人肉记实测 | 每个动作写 `data/mc-sessions/*.jsonl`，附回放脚本 |
| 反复踩同一个 goto 坑 | 每次失败都从头试 | 10 分钟失败点缓存，目标附近提前提示 |
| 测试污染真实环境 | `test-game-agent` 在 agent 在线时误判 | 该项把 `mcAgent.capabilities` 打桩为离线 |

### 7.2 仍然存在的限制

- **Baritone 全局寻路有边界**：极端地形、未加载区块、禁挖区域仍可能失败；失败会回退本地 `goto`，而本地策略依然只做局部绕行/挖/搭桥/垫高，不会整体重规划。
- **`collect` 拾取仍是瞬移**：功能可靠但与「像人一样走」有差距。
- **交易依赖村民报价**：傻子/失业村民没有报价，`trade` 会明确返回「没有报价」。
- **`bridge` 只支持直线**，且需要快捷栏有方块；斜向/拐弯需要分多次调用。
- **`smash` 的猛击加成依赖真实下落高度**：平台边缘起跳伤害更高，平地起跳只有基础加成。
- **`harvest` 不判断成熟度**：没有 age 数据，未成熟作物也收（只掉种子）；要保产量需要给 blocks 接口加 age。
- **`smeltBatch` 是同步等待**：最多等 `wait` 秒（默认 100，上限 180）；大批量要分多次调用。
- **`store` / `retrieve` 按整堆 shift**：`count` 参数没有做「只拿 N 个」，需要精确数量要再点槽位。
- **`plant` 依赖现有耕地**：没有锄地动作，需要模型自己先 `craft` 锄头并开垦（`use` 锄头未封装成动作）。
- **`sleep` 需要有效床+夜晚**：白天、床被占、周围有怪都会明确失败。
- **`task` 最多 30 步**：步骤是静态列表，执行中不会自动改计划；某步失败就暂停等模型。
- **`place` 需要相邻实心面**：目标周围没有可依附方块、或距离 >4.6 格会失败。
- **`goto` 的挖掘会改地形**：为了脱困会挖前方方块；bedrock/水/岩浆挖不动时会返回具体原因。
- **悬崖急停后仍需模型选路**：`/stop` 只负责停下，不会自动绕路；沙砾冲刺是直线跑，前方有墙时可能撞住。
- **工具耐久警告 60 秒一次**：避免每轮刷屏；没有备用时只提示，不会自动合成。
- **`reflexAutoResolve` 默认 off**：要挂机需手动在 `data/config.json` 的 `game.reflexAutoResolve` 设为 `try` 或 `force`；try/force 的自动做工具/狩猎链路只做了代码实现，尚未在真实材料/动物场景回归。
- **`smeltBatch` 是 pending 架构**：启动后必须由模型/任务队列调用 `smeltCheck` 收产物；进程重启会丢失 `smeltJob`。
- **`task` fallback 只有一层**：fallback 步骤失败不会再找第二层替代。
- **JSONL 不自动清理**：`data/mc-sessions/` 会随会话增长，需要定期归档。
- **可视化只在客户端**：目标框/路径线受区块加载影响；光柱/粒子在远距离仍可见，但需要目标坐标。
- **可视化开关在 `game.viz`**：`flow` / `targetBox` / `beam` / `trail` / `hud` 可逐项关闭；`hud` 只控制目标边缘箭头，左上角卡片是常驻的，没有单独开关。
- **卡片固定左上角**：不挡准星，但会盖住 F3 调试信息的一部分；目前不支持拖动/缩放。
- **自动换工具/武器只搬空槽**：快捷栏满时不会替换已占用槽（交换物品容易在关背包时光标丢失）；会退回快捷栏里现有的最佳工具/武器。所以想把背包里的好装备用上，需要手动留一个空槽。
- **附魔参与评分**：`/besttool` 会把 `efficiency` 按原版近似折算进挖掘速度；`/bestweapon` 把 `sharpness` 折算进 DPS；`/bestarmor` 会把 `protection`/`blast_protection`/`projectile_protection`/`fire_protection`/`thorns`/`unbreaking` 计入护甲分。但只覆盖这些常见原版附魔，模组附魔、亡灵杀手/节肢杀手等条件附魔、耐久消耗策略不参与。
- **防御模式**：默认 `defenseMode:"counter"`（锁定玩家或 4.5 格内）；`"active"` 在 `defenseRange`（默认 12，4~24）内主动清怪，可能追怪打断任务；`"passive"` 不主动开战，只在被锁定/血≤10/敌人≤4.5 格时后撤；`"off"` 关闭自动反击。苦力怕始终走“贴脸先打一下、否则后退”的专用逻辑，不进入通用反击。
- **被动防御只做装备准备**：会自动换四件护甲、把盾牌放副手，但**不会自动举盾格挡**；盾牌格挡仍需要模型/额外动作。胸甲槽是鞘翅时保留鞘翅，不自动换胸甲。
- **护甲只在安全时换**：6 格内无敌对、血>10、没开界面才开背包；战斗中不会为了换甲打断。`autoArmor:false` 可关闭。
- **中性生物按 `NeutralMob` 判断**：只有被激怒并锁定玩家时才会反击；普通牛/羊/猪不会被自动攻击。
- **Baritone 是可选依赖**：jar 在 `runtime/mc/game/mods/baritone-api-fabric-1.20.0.jar`，编译 API 在 `lib/mc/baritone-api.jar`。没装时 `goto` 仍走本地策略；Baritone 端点返回 `available:false`。
- **Baritone 会改地形**：默认允许挖/搭方块，长距离寻路可能挖穿墙壁、垫高或走进水里；`goto` 期间角色死亡会停止，但不会自动重生。
- **Baritone 与模型动作是串行的**：`goto` 会阻塞到到达/超时，期间不会执行其他动作；超时/失败会 `baritoneStop` 后回退本地 `goto`。`game.pathfinder` 可设 `auto`（默认，>10 格才用）/`baritone`（全部优先）/`local`。
- **Servux 是服务端 mod**：单人游戏不需要，也未被当前 agent 消费；多人服务器装 Servux 主要给 MiniHUD 提供结构边界等数据，后续若做多人模式可再接其结构包。

**当前行为**：所有动作失败时都会返回 `ok:false` + 原因，不再用 `ok:true` 掩盖未完成。

---

## 8. MC 26.3 API 笔记（**能省你几小时**）

### 8.1 移动 / 跳跃（26.3 的坑）

```java
// KeyboardInput.tick() 每 tick 都会用 KeyMapping 重建输入：
this.keyPresses = new Input(
    options.keyUp.isDown(), options.keyDown.isDown(), ...,
    options.keyJump.isDown(), ...);
```

所以：

- **直接写 `LocalPlayer.input.keyPresses` 没有用**——下一 tick 就被 `KeyboardInput.tick()` 覆盖。
  之前「能走」多半是惯性/掉落造成的假象。
- `KeyMapping.setDown(true)` 也会被 `KeyMapping.setAll()` 用真实输入覆盖。
- **可靠做法：Mixin 注入 `KeyMapping.isDown()`**，在合成输入生效期间返回 true。
  mod 里是 `SyntheticInput` + `KeyMappingMixin`，接口 `POST /keyhold {"keys":"w+jump","ms":800}`。
- 跳跃同理；垫高/搭桥都靠它。

### 8.2 使用物品 / 拉弓

```java
mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);   // 本地走 ItemStack.use（弓会 startUsingItem）并发包
mc.gameMode.releaseUsingItem(p);                     // 发 RELEASE_USE_ITEM + 本地 releaseUsingItem（放箭）
```

但 `Minecraft.handleKeybinds()` 每帧检查：

```java
if (player.isUsingItem() && !options.keyUse.isDown()) gameMode.releaseUsingItem(player);
```

所以 `startUsingItem` 之后下一 tick 就被松手。修法同样是 Mixin：合成右键期间让
`keyUse.isDown()` 返回 true。`/usehold` 返回 `chargedTicks`（MC 自己累计的蓄力），
引擎再校验箭数是否减少。

### 8.3 瞄准实体

**`lookAt` 是给方块用的**（坐标 +0.5 取方块中心）。**实体的 x/z 本身就是碰撞箱中心**，加 0.5 会偏半格。

```js
// engine.js:786 aimEntity()
const yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
const pitch = -Math.atan2(dy, horiz) * 180 / Math.PI;
```

并且：**先瞄准 → 停 400ms → 再发包**（服务端按包到达时的朝向打射线）。

### 8.4 护甲槽

`Inventory.armor` 在 26.3 **不公开**。改从容器菜单读：

```java
p.containerMenu.slots.get(5 + (3 - armorIndex)).getItem()   // 5=头 6=胸 7=腿 8=靴
```

### 8.5 右键实体

```java
// 之前漏了这个分支，喂牛只是把小麦挥了一下
mc.gameMode.interact(p, target, (EntityHitResult) hit, InteractionHand.MAIN_HAND);
```

### 8.6 挖掘

不要依赖 `mc.hitResult`（刚 `setYRot` 完它还是上一帧的）。自己按方块中心算 yaw/pitch + `setYHeadRot`，然后 `continueDestroyBlock` 循环。

### 8.7 瞬移

```java
p.setPos(x, y, z);
p.setDeltaMovement(0, 0, 0);
p.setOnGround(false);   // 必须！否则玩家悬在半空不掉下来，往下挖永远挖不动
```

### 8.8 查 API 的方法

```bash
export PATH="/c/Program Files/Microsoft/jdk-25.0.5.21-hotspot/bin:$PATH"
javap -classpath runtime/mc/versions/26.3/26.3.jar net.minecraft.world.entity.LivingEntity | grep -i using
```

### 8.9 实体查询 / 直接交互 / 暂停 / 容器

- **不要用 `level.entitiesForRendering()`**：它只返回当前视锥里正在渲染的实体。
  背后的村民、刚召唤的怪都会「不存在」。用：
  ```java
  level.getEntities(p, p.getBoundingBox().inflate(16.0), e -> true)
  ```
- **实体坐标不要 `%.0f`**：瞄准/距离判断会偏半格。`state.entities` 现在保留两位小数。
- **右键实体不依赖准星**：
  ```java
  mc.gameMode.interact(p, target, new EntityHitResult(target), InteractionHand.MAIN_HAND);
  ```
- **攻击实体不依赖准星**：
  ```java
  mc.gameMode.attack(p, target);
  ```
  服务端按实体 id 和距离校验（约 3 格），完全不需要 `mc.hitResult`。
  自动反击/`fight`/`smash` 用 `eid` 精确锁定目标，避免同类型怪里打到最近的那只。
- **工具评分**：`ItemStack.isCorrectToolForDrops(state)` 优先，其次
  `ItemStack.getDestroySpeed(state)`；不要按物品名硬编码，模组工具也能参与。
- **武器评分**：`stack.forEachModifier(EquipmentSlot.MAINHAND, ...)` 读
  `Attributes.ATTACK_DAMAGE` / `ATTACK_SPEED`；DPS = 伤害 × 攻速，附魔不在此列。
- **敌我识别**：`e instanceof net.minecraft.world.entity.monster.Enemy` 才是敌对；
  `NeutralMob` 只有 `getTarget()==player` 才反击。不要用 `/zombie/` 这类正则，
  `zombified_piglin` 会被误伤。
- **实体列表按距离排序**：`level.getEntities(...)` 不保证顺序，自动反击/战斗
  必须先按 `distanceTo(p)` 排序再取最近 12 个，否则近处的怪可能被掉落物挤掉。
- **失焦暂停**：`onInitializeClient` 时 `Minecraft.getInstance().options` 还是 null；
  在第一个 `ClientTickEvents.END_CLIENT_TICK` 里设 `pauseOnLostFocus=false` 才有效。
  `mc.isPaused()` 为 true 时世界不推进，所有动作都“没反应”。
- **关闭容器**：只 `gui.setScreen(null)` 不会发 `ServerboundContainerClosePacket`，
  `player.containerMenu` 会残留。用 `LocalPlayer.closeContainer()`。
- **鞘翅**：`p.tryToStartFallFlying()` 只建本地状态，还要补发：
  ```java
  p.connection.send(new ServerboundPlayerCommandPacket(p,
      ServerboundPlayerCommandPacket.Action.START_FALL_FLYING));
  ```
- **`craft` 的摆料**：`handlePlaceRecipe(id, recipe, true)` 会摆满所有材料；
  想精确做 1 个必须传 `false`。
- **`/stop`**：清空 `SyntheticInput` + `LocalPlayer.input.keyPresses`。悬崖急停必须调它，
  只把任务标记为 paused 不会阻止惯性。
- **`/place`**：目标坐标 + 相邻实心面构造 `BlockHitResult`，逐个面尝试，不依赖准星。
- **会话日志**：`data/mc-sessions/*.jsonl` 每个动作一行；`node tools/replay-mc-session.js <file>`
  输出动作分布、失败列表、最近 10 条。
- **可视化渲染事件**：26.3 的 Fabric API 不再用 `WorldRenderEvents`，改用
  `LevelRenderEvents.AFTER_TRANSLUCENT_FEATURES`；HUD 用 `HudElementRegistry.addLast`。
- **坐标**：关卡渲染的 `PoseStack` 是**相机相对**的。世界坐标下画笔之前必须
  `pose.translate(-camera.x, -camera.y, -camera.z)`，否则线框会画在错误位置。
- **线条**：`submitCustomGeometry(pose, RenderTypes.linesTranslucent(), (p, vc) -> ...)`，
  顶点用 `vc.addVertex(p, x,y,z).setColor(r,g,b,a).setNormal(p,0,1,0).setLineWidth(w)`。
- **粒子**：`mc.level.addParticle(ParticleTypes.END_ROD, x,y,z, 0,0,0)`；流光/光柱独立开关。
- **常驻卡片**：`GuiGraphicsExtractor.fill(x1,y1,x2,y2,ARGB)` 画半透明底/边，
  `gui.text(font,text,x,y,ARGB,shadow)` 画字；状态按 `font.width()` 截断，不能用字符数。
  卡片进世界就常驻，空状态显示待命；`hud` 只控制边缘箭头；停止时 `clearVisualize()` 把数据清空。

---

### 8.10 Baritone 26.3 集成

- 版本：Baritone **1.20.0** 发布包已覆盖 Minecraft 26.3；运行时用
  `runtime/mc/game/mods/baritone-api-fabric-1.20.0.jar`，编译用 `lib/mc/baritone-api.jar`。
- 入口：
  ```java
  IBaritone b = BaritoneAPI.getProvider().getPrimaryBaritone();
  b.getCustomGoalProcess().setGoalAndPath(new GoalXZ(x, z));       // 只约束水平
  b.getCustomGoalProcess().setGoalAndPath(new GoalNear(pos, 2));   // 带 y/半径
  ```
- 状态：
  ```java
  IPathingBehavior pb = b.getPathingBehavior();
  pb.isPathing(); pb.hasPath(); pb.getGoal();
  pb.getCurrent().getPath().positions();   // 实际路径点，可喂给可视化
  ```
- 停止：`b.getPathingBehavior().cancelEverything()`。**角色死亡/暂停时不会自动停**，
  Node 轮询 `/state.dead`/`paused`，发现异常先 `baritoneStop`。
- 可选加载：`BaritonePathing` 单独成类；没装 Baritone 时首次访问抛
  `NoClassDefFoundError`，`ControlServer` 捕获并返回 `available:false`，主 mod 仍能加载。
- 构建：`mcmod/build.js` 把 `lib/mc/baritone-api.jar` 加入 javac classpath；
  运行时完整 jar 在 `runtime/mc/game/mods/`，两者不要混放反。

## 9. 调试陷阱（都踩过）

### 9.1 8787 ≠ 8788

- **8787**（网关）：`/api/game/*`、`/api/mc/launch`、`/api/status`
- **8788**（mod）：`/state`、`/chat`、`/click`、`/use`、`/gui`...

`/api/mc/state`、`/api/mc/chat` **在 8787 上不存在**。曾经因此测出「背包全空」，其实命令根本没发到游戏里。

### 9.2 召唤生物要在实心地面上

玩家站在树冠/悬空时 `/summon ~ ~ ~` 出来的生物会**窒息或掉走**。测试前先 `/tp` 到地面。

### 9.3 树冠地形是测试地狱

村民会掉到地面（y 差 7~8 格），`goto` 跟不下去；右键总打到树叶。**测交互类功能先找平地。**

### 9.4 准星对着方块时，右键不是「使用物品」

`use` 会变成「和方块交互」，拉弓会被取消。射箭前先升到开阔处或抬头。

### 9.5 传送升空要加缓降

```bash
/effect give @p minecraft:slow_falling 20 1
```

否则测试滑翔会摔死（实测死过一次，掉了 7 血）。

### 9.6 中文路径

项目在 `D:\AI\女儿`。`-javaagent` 的路径**不能带中文**，否则 JVM 加载 agent 时崩。`launcher.js` 已经会自动复制到 `C:/aibridge-rt/agent.jar`——**别改掉这段逻辑**。

### 9.7 启动随机崩溃

MC 26.3 在这台机器上启动阶段会随机崩（jvm.dll 访问违例）。已加 `-XX:-TieredCompilation` 缓解，**不要删**。

### 9.8 代理

本机请求必须加 `--noproxy '*'`（这台机器走 HTTP_PROXY，curl 会把 127.0.0.1 也代理走）。

### 9.9 构建 JDK

`node mcmod/build.js` 会自己找 JDK（`JAVA_BIN` → `JAVA_HOME` → PATH → 常见目录，挑主版本最高的）。手动跑 gradle 要自己 `export PATH` 到 JDK 25。

### 9.10 负坐标必须 floor，不能 round

`BlockPos.containing(-6.3)` 得到的是 **-7**，`Math.round(-6.3)` 是 **-6**。
`blocks` 返回的 dx/dy/dz 以脚下方块为原点，JS 侧相加前必须
`Math.floor(player.x/y/z)`。这个 bug 的表现是「chop 说挖了 N 块，背包 0，方块还在」——
挖到了隔壁的空气/方块。

### 9.11 死亡后世界不推进

`state.dead=true` 时所有动作都会“没反应”：不跳、不走、不挖。
`execAgentAction` 每 1.5 秒检查一次并自动 `open respawn`；测试时也可以手动
`POST /ui {"what":"respawn"}`。死亡界面在 `/gui` 里能看到「重生」按钮。

### 9.12 窗口失焦会暂停

即使关掉 `pauseOnLostFocus`，**mod 初始化时 options 还是 null**，必须在第一个
client tick 设置。`/state.paused=true` 时先调 `POST /resume`。
测试期间用无头方式发 HTTP 请求不会抢焦点，但用 PowerShell/AppActivate 切窗口后
可能触发一次暂停。

---

## 10. 参考项目

**https://github.com/blueziii/dsh-mc-agent** —— 基于 mineflayer 协议层的 MC Bot（41 个工具，不需要服务端 mod）。

值得看的点：

1. **它把自己手写的走路器整段删了**，换 `mineflayer-pathfinder`。原因：「瞎跳」「绕远/掉坑」「卡住判据看有没有动，结果挪了 25 格却离目标 49 格也算有进展」
2. **三态判决**：成功 / 失败 / **结果未知**，别把「发了包」当「成功了」
3. **先瞄准、停顿、再发包**（服务端按包到达时的朝向打射线）
4. 它的《踩坑档案》记录了 151 个真实 bug

`goto` 就是照它重写的：卡住判据（比历史最近还近 0.35 格才算进展）+ 三级脱困
（重新瞄准 → **边走边跳** → 后退半步）+ 到达判定分两轴（水平够近 **且** 高度差 ≤1.5）。
2026-11-08 又把「跳一下」改成 `w+jump` 同时按住，否则原地跳永远上不了台阶。

**https://github.com/cabaletta/baritone** —— 已接入 Baritone 1.20.0（26.3 Fabric）做全局寻路。
使用它的 `BaritoneAPI` / `GoalXZ` / `GoalNear` / `IPathingBehavior`，没有改它的源码；
运行时 jar 在 `runtime/mc/game/mods/baritone-api-fabric-1.20.0.jar`，编译 API 在 `lib/mc/baritone-api.jar`。

**https://github.com/sakura-ryoko/servux** —— 服务端数据 mod，给 MiniHUD 等客户端提供结构边界/实体等数据。
单人游戏不需要，当前 agent 未消费其网络包；如果以后做多人服务器模式，可在客户端补结构包接收端。

---

## 11. 建议的下一步（按优先级）

| 优先级 | 任务 | 理由 |
|---|---|---|
| **P0** | 用真实模型跑完整 agent 循环（不是 `execAction` 单测） | 验证提示词 + 决策 + 50 个动作 + task 队列的端到端效果 |
| **P1** | 任务队列的动态重规划 | 现在 steps 是静态列表 + 一层 fallback；失败后仍只能 resume/取消 |
| **P2 ✅** | Baritone 全局寻路已接入 | `goto` >10 格自动走 Baritone，失败回退本地；剩余可做的是多人 Servux 结构数据接入 |
| **P3** | 给 `blocks` 加 age 字段，实现「只收成熟作物」 | 现在 `harvest` 会连未成熟的一起收 |
| **P4** | `reflexAutoResolve` / `plannerProviderId` / `game.viz` 做进「游戏」页 UI | 现在只能手改 `data/config.json`；JSONL 分析也还没接页面 |
| **P5** | 可视化数据质量：目标框跟随实体 | 路径已能显示 Baritone 实际 path（`state.vizTrail`）；目标框仍只支持方块坐标 |

---

## 12. 交接检查清单

- [ ] `node server.js` 起来，8787 返回 200
- [ ] `node mcmod/build.js` 能编译通过（JDK 25），jar 里有 `aibridge.mixins.json` 和 `KeyMappingMixin.class`
- [ ] 游戏能启动并进入世界（`inWorld: true`，`api: "23"`）
- [ ] `/api/game/act` 能跑通 `goto` / `collect` / `makeTool`
- [ ] `/usehold` + `/state.useChargeMs` 能蓄力，箭数会减少
- [ ] `/pillar` / `/bridge` 能垫高/过沟
- [ ] `/interact` 能打开村民交易，`/trades` 有报价
- [ ] `/hit` 能对实体造成伤害（`state.entities[].hp` 下降），支持 `eid` 精确锁定
- [ ] `store` / `retrieve` 能存/取箱子，`smith` 能合一个物品
- [ ] `smeltBatch` 能烧 N 个矿，`plant` / `harvest` 能种/收
- [ ] `sleep` 在夜晚 + 有效床上能睡着
- [ ] 反射层：3 只怪 5 格内 + 血<12 会 `reflex:surrounded`
- [ ] cost guard：连续 5 轮同类动作会提示并切规划模型
- [ ] `place` 能在指定坐标放方块，`task` 能自动跑完多步
- [ ] `/state` 有 `front` / `frontDrop` / `unstableAbove` / `air` / `handDamage` / `helmet` / `chest` / `leggings` / `boots` / `offhand` / `blocking` / `lastAttacker`
- [ ] `goto` 遇 bedrock 会返回「前方是 minecraft:bedrock」而不是干等
- [ ] 反射层能报 `reflex:tnt` / `reflex:cliff` / `reflex:tool_low` / `reflex:food_low`
- [ ] `/stop` 能在按住 W 时立刻停住
- [ ] `runtime/mc/game/mods/baritone-api-fabric-1.20.0.jar` 存在，`/state.caps` 含 `baritone`
- [ ] `/baritone/status` 返回 `available:true`；`goto` >10 格会进入 `pathing:true`
- [ ] 拔掉 Baritone jar 后 AIBridge 仍能加载，`goto` 回退本地
- [ ] `/besttool` 能按方块选镐/斧/锹；快捷栏满时退回现有最佳工具
- [ ] `/bestweapon` 能按 DPS 选剑/斧；自动反击会先切武器
- [ ] `/besttool`/`/bestweapon` 会读取 `efficiency`/`sharpness`；`/bestarmor` 会按保护类附魔推荐并换甲
- [ ] 2 格僵尸会触发 `reflex:defend`，普通牛不会触发
- [ ] `defenseMode:"active"` 会主动接近 `defenseRange` 内敌对；`"passive"` 会 `reflex:retreat`
- [ ] 安全时自动换四件护甲并装盾，鞘翅不会被胸甲替换
- [ ] `task` 预检能拒绝 y=999 的 place，fallback 能接住失败步骤
- [ ] `smeltBatch` 返回 pending，`smeltCheck` 能收产物
- [ ] `data/mc-sessions/*.jsonl` 有记录，`npm run replay:mc -- <file>` 能汇总
- [ ] `POST /visualize` 后游戏里能看到目标框/路径线/光柱/HUD
- [ ] `game.viz` 里逐项关掉后对应效果消失（受渲染事件/区块加载影响）
- [ ] 知道 8787 和 8788 的区别
- [ ] 知道 `data/config.json` 不能碰
- [ ] 知道负坐标要 floor、死亡要先重生（第 9 节）

---

## 附：常用命令速查

```bash
# 启动
cd "D:/AI/女儿" && node server.js
curl -X POST http://127.0.0.1:8787/api/mc/launch

# 状态
curl --noproxy '*' http://127.0.0.1:8788/state
curl --noproxy '*' http://127.0.0.1:8787/api/game/status

# 单动作
curl -X POST http://127.0.0.1:8787/api/game/act -d '{"action":"feed","animal":"cow","count":1}'

# 指令
curl -X POST http://127.0.0.1:8788/chat -d '{"text":"/give @p minecraft:diamond 1"}'

# 输入诊断
curl --noproxy '*' http://127.0.0.1:8788/inputdebug

# 构建
node mcmod/build.js
```
