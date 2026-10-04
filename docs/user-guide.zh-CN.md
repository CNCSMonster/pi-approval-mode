# pi-approval-mode 用户指南（中文）

[English](./user-guide.md) | 简体中文

> **pi-approval-mode** 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的
> 多级工具审批、四态权限规则与两阶段 LLM 安全分类器插件的**完整用户手册**。
> 简介与功能亮点见 [README](../README.md)。

---

## 1. 快速上手

### 1.1 安装

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

随时 `pi update` 更新。插件自动激活，**零核心改动**。

### 1.2 首次运行（`auto` 模式）

全新安装后插件以 **`auto`**（分类器驱动）模式启动——日常工作的实用默认：

- 工作区内的**只读工具**（`read` / `grep` / `find` / `ls`）自动放行——排查问题零打扰；
- **工作区内常规编辑**自动通过；弹窗仍会出现于**分类器拦截的 Shell 命令、受保护路径修改、工作区外读取，以及命中 `ask` 规则的操作**；
- 想每笔变更都确认？`/approval-mode manual` 切换到 **`manual`**（§1.4）。

### 1.3 审批对话框

每个对话框提供五种动作——**直接按数字键 `1`–`5` 瞬间选择**（无需回车）：

| 键 | 动作 | 作用域 |
| :--- | :--- | :--- |
| `1` | 允许本次执行 | 仅此一次 |
| `2` | 始终允许（本会话） | 内存态，随会话结束失效 |
| `3` | 始终允许在本项目 | 持久化到 `<workspace>/.pi/approval-rules.json` |
| `4` | 始终允许对该用户 | 持久化到 `~/.pi/agent/approval-rules.json` |
| `5` / `Esc` | 拒绝执行 | 向模型反馈拒绝原因，模型自行调整 |

选择 `2`–`4` 会在对应层级写入一条 `allow` 规则，同款操作以后在该范围内不再打扰你。

### 1.4 切换模式

- **`Ctrl+Alt+A`** — 循环切换 `manual ➔ auto-edit ➔ auto ➔ yolo ➔ plan`；
- **`/approval-mode [mode]`** — 直达指定模式（支持 Tab 补全，如 `/approval-mode auto`）。

当前模式常驻状态栏（如 `[⚖️ auto]`；若 Stage 1 快筛离线则常驻显示 `[⚖️ auto | S1⚠️]`，见 §4.4 与 §5.7）。

> ⚠️ **注意区分**：状态栏第 2 行上下文用量后的 `(auto)` 是 **Pi 原生的上下文自动压缩指示**（`compaction.enabled`，见 Pi 官方 `docs/settings.md`），与本插件无关；本插件的审批模式徽标位于扩展状态行（如 `[⚖️ auto]`）。两者详见 §5.7。

### 1.5 建议的下一步

先读 **§2** 弄清每个模式对各类工具的确切行为；要在 `auto` 模式启用分类器请读 **§4**。

---

## 2. 审批模式 × 工具行为

### 2.1 裁决管线

每次工具调用**按顺序**经过以下阶段，首个命中者裁决：

```
死循环熔断 ─▶ deny 规则 ─▶ ask 规则 ─▶ default / allow 规则 ─▶ 工具默认权限层 ─▶ 模式漏斗
```

1. **死循环熔断** — 连续同款失败调用被熔断（触达硬上限即使交互态也直接阻断）。
2. **`deny` 规则** — 一切模式下静默硬阻断，不弹窗。
3. **`ask` 规则** — **强制弹窗**，压倒一切免审模式（含 `yolo`）。
4. **`default` 规则** — 把裁决交给*模式漏斗*（这就是"按需付费"裁决：不配 `default` 规则，行为与经典三态一致）。
5. **`allow` 规则** — 一切模式下自动放行——**`auto` 模式例外**：宽到足以绕过分类器的 allow 规则（工具级 `Bash`、解释器通配如 `Bash(npx *)`）进入 `auto` 时被暂存剥离，退出时归位。
6. **工具默认权限层**（仅读类工具、未命中规则时）— 工作区内自动放行；工作区外（含 `~` 展开）**包括 `yolo` 在内的一切模式**都需人工确认。
7. **模式漏斗** — 即下表所述的分模式行为。

### 2.2 行为矩阵

五个模式构成自动化梯度——`manual → auto-edit → auto → yolo`（`plan` 正交）。模式是列、调用状态是行。带 `*` 的单元格见表下注释。

| 调用 | `manual` | `auto-edit` | `auto` | `yolo` | `plan` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `edit` / `write` — 工作区常规文件 | 🛡️ 弹窗 | ✅ 自动 | ✅ 自动 | ✅ 自动 | ⛔ 阻断 |
| `edit` / `write` — **工作区外** | 🛡️ 弹窗 | 🛡️ 弹窗 | ⚖️ 分类器 → 弹窗 `*` | ✅ 自动 | ⛔ 阻断 |
| `edit` / `write` — **受保护路径** `*` | 🛡️ 弹窗 | 🛡️ 弹窗 | ⚖️ 分类器 → 弹窗 `*` | ✅ 自动 | ⛔ 阻断 |
| `bash` — 只读（词法分析判定） | 🛡️ 弹窗 | 🛡️ 弹窗 | ⚖️ 分类器 → 弹窗 | ✅ 自动 | ✅ 自动 |
| `bash` — 其余命令 | 🛡️ 弹窗 | 🛡️ 弹窗 | ⚖️ 分类器 → 弹窗 `*` | ✅ 自动 | ⛔ 阻断 |
| 读类、无规则、**工作区内** | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 |
| 读类、无规则、**工作区外**（除 skill 目录 `*` 外） | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 |
| 读类、命中 **`default`** 规则 | 🛡️ 弹窗 | 📝 弹窗 | ⚖️ 分类器 → 弹窗 `*` | ✅ 自动 | ✅ 自动 |
| 命中 **`ask`** 规则（任意模式） | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 |
| 命中 **`deny`** 规则（任意模式） | ⛔ 静默阻断 | ⛔ 静默阻断 | ⛔ 静默阻断 | ⛔ 静默阻断 | ⛔ 静默阻断 |
| 命中 **`allow`** 规则（任意模式） | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 |

`*` **注：**

- **受保护路径** = 工作区敏感位置（`.pi/`、`.git/`、`AGENTS.md`、`.bashrc` / `.zshrc` / `.profile` 等点文件、`.env*`、`id_rsa*`）。`auto` 模式下这些路径不走快路径，改走分类器。
- **分类器 → 弹窗**：两阶段 LLM 分类器结合对话上下文研判该调用。判为有风险则弹窗展示风险理由，之后仍是 `1`–`5` 选择；判为安全则无感放行。
- **skill 目录** `*` = 用户级 `~/.pi/agent/skills/**` 与 `~/.agents/skills/**`（恒豁免）+ 项目级 `.pi/skills/**` 与 `.agents/skills/**`（仅受信项目豁免）；显式 `deny`/`ask` 规则仍然优先于白名单。
- **只读 `bash`** 由 Shell 状态机判定（引号、重定向、管道、`&&`/`;` 切分、`$( )` 替换、`find`/`git`/`sed` 参数守卫）。任何一处写入重定向即一票否决只读资格。**在 `auto` 下只读快路径已下线**：该分析现仅守卫 `plan`（硬拦）并为 `auto` 弹窗的“静态结构特征”展示行供料——展示≠裁决。每一条未命中规则的 shell 调用（含 `ls`）都进分类器；想把某命令钉回 0 秒，写一条 `allow` 规则。

### 2.3 无头（非交互）运行

没有 UI 时（`pi -p …`）无法弹窗，一切"需人工"结局改为**英文拒绝消息**——告诉模型原因与安全出路：

- `ask` 规则 → `[Permission: ask] Rule … requires interactive confirmation …`
- 分类器拦截 → `[Auto Mode] … blocked by the safety classifier …`
- manual 模式需人工 → `[Manual Mode] … no interactive UI …`
- 死循环硬上限 → `[Circuit Breaker] … do not retry …`

`auto` 无头运行中，分类器**不可用**时会静默回落到确定性启发式规则（失败安全：高危模式仍会拦截，见 §4.3）。

---

## 3. 规则 Cookbook

### 3.1 DSL 语法

```
Tool(specifier)
```

| 宏分类 | 覆盖工具 | specifier 示例 |
| :--- | :--- | :--- |
| `Read` | `read`、`grep`、`find`、`ls`（及别名） | `Read(/src/**)`、`Read(.env*)`、`Read(~/.ssh/**)` |
| `Edit` | `edit`、`write` | `Edit(/package.json)`、`Edit(./config/**)` |
| `Bash` | `bash` | `Bash(git status)`、`Bash(git push *)`、`Bash(sudo *)` |

**作用域前缀**（加在 specifier 上）：

| 前缀 | 含义 |
| :--- | :--- |
| `//…` | 绝对文件系统路径（`//etc/**`） |
| `~/…` | 家目录（`~/notes/**`） |
| `/…` | 项目根相对（`/src/**`） |
| `./…` 或裸写 | 工作区/当前目录相对（`Read(.env*)`、`Edit(./config/**)`） |

### 3.2 裁决优先级与层级

$$\text{Deny} > \text{Ask} > \text{Default} > \text{Allow}$$

规则跨三个持久化层级（会话 / 项目 / 用户）**并集成池**。**裁决类型优先级严格高于层级**——
用户层的 `deny` 永远压死项目层的 `allow`。层级只决定规则**存在哪、活多久**，不决定谁胜出。

### 3.3 配方手册

```jsonc
// ~/.pi/agent/approval-rules.json  （用户全局）
{
  "deny":    ["Read(~/.ssh/**)", "Bash(git push *--force*)"],  // 绝对底线，静默拦截
  "ask":     ["Bash(git push *)", "Edit(/package.json)"],      // 永远人工确认
  "default": ["Read(./secrets/**)"],                           // 交给审批模式漏斗
  "allow":   ["Bash(git status)", "Bash(git diff *)"]          // 永不打扰
}
```

| 目标 | 配方 |
| :--- | :--- |
| 全局保护凭据文件 | `"deny": ["Read(.env*)", "Read(~/.ssh/**)"]` |
| `auto` 下强制敏感读取走**分类器审计** | `"default": ["Read(./secrets/**)"]` — 该读取不走工作区快路径，改入分类器 |
| 静音日常 git 命令 | `"allow": ["Bash(git status)", "Bash(git diff *)"]` |
| 自己硬拦破坏性 git（无内置规则——分类器按安全常识研判） | `"deny": ["Bash(git push *--force*)"]` |
| 发布类推送永远人工确认 | `"ask": ["Bash(git push *)"]` |
| 交给模式裁决（选择性启用高级行为） | `"default": [...]` — 完全不配 `default` 规则即保持经典三态 |

### 3.4 查看与维护：`/approval-rules`

- `/approval-rules` — 列出四池规则、计数与来源（会话/项目/用户），并展示影子/冲突警告
  （低severity 规则永远无法生效时提示）；
- `/approval-rules clear` — 清空规则池（需确认）。

审批弹窗的 `2`/`3`/`4`（§1.3）是加规则的顺手方式，本命令用于**审查与维护**。

---

## 4. 分类器与模型配置

### 4.1 分类器做什么

**`auto`** 模式下，每一条未命中规则的 shell 调用（只读快路径已下线——`ls` 同样进分类器）、受保护路径编辑、`default` 路由的读取
进入**两阶段 LLM 研判**：

- **Stage 1** — 极速 JSON 判定（带超时熔断）；
- **Stage 2** — 仅当 Stage 1 拦截时启动思维链复核，消除误报；
- 结论与可读的风险理由进入弹窗（无头模式下转为拒绝消息）。

### 4.2 配置 `classifierModel`

`~/.pi/agent/approval-config.json`：

```json
{
  "classifierModel": "<provider>/<model>",
  "classifierStage1Model": "<provider>/<cheap-model>",
  "classifierStage2Model": "<provider>/<smart-model>",
  "defaultMode": "auto",
  "classifierTimeoutMs": 1500
}
```

- **`<provider>/<model>`** 必须存在于 Pi 模型注册表（`~/.pi/agent/models.json`）。
  挑便宜快的小模型即可——分类器只回答一个小小的 JSON 问题：

```jsonc
// ~/.pi/agent/models.json（节选）
"providers": {
  "my-proxy": {
    "api": "openai-completions",
    "apiKey": "$MY_PROXY_API_KEY",        // env 引用——绝不要把明文 key 写进文件
    "baseUrl": "https://example.com/v1",
    "models": [{ "id": "fast-model", "contextWindow": 128000, ... }]
  }
}
```

- **切勿在配置文件里存 API key**。用上面的 `$ENV_VAR` 引用形式，在启动 Pi 的环境里导出变量。
- **运行时查看或配置分类器模型**：**`/classifier-model`**
  - **查看状态**：直接执行 `/classifier-model`，回显 Stage 1（快筛）与 Stage 2（复核）的当前配置值、生效值与回退原因。
  - **分阶段独立设置**：`/classifier-model --stage1 <provider/model>` 或 `/classifier-model --stage2 <provider/model>`（支持一次性指定两阶段，如 `/classifier-model --stage1 deepseek/deepseek-flash --stage2 deepseek/deepseek-v4-pro`，顺序无关）。
  - **统一设置两阶段**：`/classifier-model --both <provider/model>`（写入共享键并清空分阶段键）。
  - **清空配置**：`/classifier-model clear`（重置全部回到内置默认及主模型）；亦可按目标清除 `/classifier-model clear --stage1`（或 `--stage2` / `--both`）。
  - **帮助与补全**：`/classifier-model help` 显示语法与示例；支持全流程 Tab 自动补全，候选列表智能剪枝互斥选项，展示模型价格、推理与上下文窗口元数据，并对当前生效模型标注 `✓`。
  - **语法迁移说明**：旧语法位置参数 `/classifier-model <model>` 与 `/classifier-model default` 已移除，请分别迁移为 `--both <model>` 与 `clear`。
- `defaultMode` 设定启动模式；项目级 `.pi/approval-config.json` 按顶层键整体覆盖全局
  （且仅在**受信任**项目生效——见 §5.4）。

### 4.3 超时与优雅降级

- Stage 1 受 `classifierTimeoutMs` 约束（默认 **1500 ms**）；模型慢就调大；
- 分类器**不可用**（未配置、连不上、反复超时）时，`auto` 模式回落到**确定性启发式规则**——
  破坏性 `rm`、`curl | sh`、force-push、凭据路径等高危模式依然拦截；
- 因此启发式放行**不等于**分类器真的回答过——区分方法见 §5.2。

### 4.4 Stage 1 健康感知与持续失效排查

Stage 1 快速快筛设计初衷是以 ~200ms 的极速与极低 Token 消耗放行 95% 以上的安全工具调用。当 Stage 1 发生故障（超时、网络断连、上游拦截或解析异常）时：

1. **不阻塞原则**：系统自动将审批流转由 Stage 2 深度复核接管，**绝对不阻塞 Agent 执行**，也不会误触不可用熔断；
2. **状态栏常驻感知**：底部状态栏会自动从 `[⚖️ auto]` 切换为常驻的 **`[⚖️ auto | S1⚠️]`**，用户无需翻阅历史日志即可一眼感知；
3. **阶梯式升级提醒**：若 Stage 1 连续失败达 **5 次**（表明快筛模型可能持续离线、配额耗尽或超时过短），系统会弹出明确的升级告警，提示当前单次工具调用的审批延迟与 Token 开销已显著增加；
4. **自愈与复位**：只要 Stage 1 成功响应一次，状态栏立即自动复原为 `[⚖️ auto]`，连续失败计数清零；
5. **排查操作**：
   - 运行 `/classifier-model` 查看 Stage 1 当前的连续失败次数与最近一次失败原因（`lastFailureReason`）；
   - 执行 `/classifier-model --stage1 <provider/model>` 切换到响应更快、更稳定的模型；
   - 若因网络抖动超时，在 `~/.pi/agent/approval-config.json` 中适当调大 `classifierTimeoutMs`。

---

## 5. 常见问题与排查

### 5.1 Pi 报 "No API key found"

模型 provider 从环境变量读 key（即 `models.json` 里的 `$VAR` 引用）。该变量没有到达 Pi 进程。排查清单：

1. **启动 Pi 的那个 shell** 里变量在吗？（`echo ${VAR:+SET}`——只看长度不打印值。）
2. 启动时会重建环境的交互 shell（各类框架、版本管理器、`mise`/`direnv` 式每 prompt
   重新导出的钩子）可能洗掉早先注入的变量。**把 export 与 Pi 启动放在同一命令行**：
   ```bash
   export MY_PROXY_API_KEY=$(cat /path/to/credfile) && pi …
   ```
3. 在运行中的进程里验证：`/proc/<pid>/environ` 应包含该变量。

### 5.2 "分类器好像全放行"——真是这样吗？

宽松结局有三种成因，可以区分：

1. **调用确实被判安全** —— 无弹窗、调用执行；
2. **分类器不可用**、启发式回落放行（看分类器告警通知；临时调大 `classifierTimeoutMs` 或换更快模型）；
3. **调用根本没到插件** —— 模型在发出工具调用之前就自我拒绝了（见 §5.3）。

可靠判据：**真实的分类器结论自带自然语言风险理由**（弹窗或拒绝消息里）；启发式回落的文案是模板句式。

### 5.3 模型拒绝 vs 插件拦截

两道防线、两种体验：

| | 模型自我拒绝 | 插件门禁 |
| :--- | :--- | :--- |
| 表现 | 一段抱歉的纯文本，**没有任何工具调用发生** | 弹窗，或工具调用之后结构化的 `Blocked` / `[模式] …` 消息 |
| 谁裁决的 | 对话模型自身的安全训练 | 规则引擎 / 分类器 / 模式矩阵 |
| 绕过 | — | 重试同一调用会再次进入同一门禁；拒绝反馈也明确告知模型不得换路径绕行 |

若测试中*需要*调用真的进入门禁，把请求措辞成朴素的工具动作即可（模型对"读取并外发"
这类复合请求常常在发出工具调用之前就先拒绝）。

### 5.4 为什么项目配置没生效？

几乎可以肯定撞上了**信任闸**：项目级 `.pi/approval-config.json` 与 `.pi/approval-rules.json`
只在受信任项目中生效。不受信任（如刚克隆的）仓库回落到全局配置并告警——这挡住了恶意仓库
自带 `defaultMode: "yolo"` 或 `allow: ["Bash(*)"]` 提权。用 `pi --approve …` 或信任弹窗
信任该项目后，其本地配置即生效。

### 5.5 我的临时授权去哪了？

审批 `2`（会话级）只在内存里，随会话结束消失；`/reload` **会保留**会话级规则
（并热载模型）。想留久用 `3`（项目级）或 `4`（用户级）。恢复遗留在 `yolo` 状态的旧会话时，
插件会**自动降级回安全基线（`auto`，或你配置的 `defaultMode`）**——真要全自动请显式 `pi --yolo`。

### 5.6 `default` 模式哪去了？

v0.3.0 起更名为 **`manual`**。新会话默认 `auto` 后，`default` 这个名字已名不副实，且与规则四态判定 `default`（语义不变）撞名。旧值透明兼容：配置里的 `defaultMode: "default"`、`--approval-mode default` 与历史会话状态都会自动映射为 `manual`。

---

### 5.7 状态栏的 `(auto)` 和 `[⚖️ auto]` 是一回事吗？

不是，两者语义、位置、控制方都不同：

| 显示 | 含义 | 由谁控制 |
| :--- | :--- | :--- |
| 第 2 行 `0.0%/262k (auto)` | **Pi 原生**的上下文自动压缩（auto-compaction）开关指示——显示即表示上下文接近上限时会自动压缩 | `settings.json` 的 `compaction.enabled`（Pi 内置，项目配置也可关） |
| 扩展状态行 `[⚖️ auto]` | **本插件**的审批模式徽标（健康态）：⚖️ 天平代表两阶段 LLM 分类器正常运转，Stage 1 极速快筛在线 | `/approval-mode` 命令、`Ctrl+Alt+A`、`--approval-mode` flag |
| 扩展状态行 `[⚖️ auto \| S1⚠️]` | **本插件**的审批模式徽标（Stage 1 降级态）：Stage 1 快筛离线或异常，已由 Stage 2 深度复核接管。Agent 不受阻塞，但单次工具审批延迟增加 | 本插件运行状态机（Stage 1 degraded 自动常驻，恢复后复原） |

Pi 本身不内置审批机制（官方文档明示 intentionally does not include permission popups），审批能力全部由本插件提供；两个 "auto" 分属完全不同的子系统，仅是文字撞名。

---

## 6. 开发与测试

```bash
git clone https://github.com/CNCSMonster/pi-approval-mode.git
cd pi-approval-mode
npm test        # node --test --experimental-strip-types tests/*.ts —— 无需安装依赖
```

目录结构：

- `extensions/` — 插件源码（`approval-mode.ts` 是 `package.json` 注册的入口）；
- `tests/` — 全量测试（规则引擎、处置矩阵、分类器投影、Shell 分析器、死循环检测、
  策略一致性、信任闸、reload 生命周期、危险 allow 护栏、模式别名）；
- `README.md` / `docs/user-guide.md` — **同步副本**；文件头有指向权威文档的来源注释，
  改文档请去源头改。

测试名按行为组织（"四态优先级"、"读取门禁"、"按需付费"），所以 `grep` 测试套件是
查证 §2 矩阵任何边界情形最快的方式。
