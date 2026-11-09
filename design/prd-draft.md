# Evener · Harness 任务分流插件 PRD 初稿(2026-11-09)

> 讨论用草稿。Evener:多马挽具中分配拉力的横杆(whiffletree),中文「匀杆」。标语:透明地掺沙子。
> 定位:面向编码 agent 委派的可观测性 + 策略评估/优化层,路由是执行手段。
> 第一版 host:Claude Code。目标 harness:Codex CLI、DeepSeek Harness(dsh)。纯本地存储,开源。

## 0. 已核实的外部事实(2026-11-09 spike 完成,详见 `design/spec-v1.md` §1)

- Codex:`codex exec --json` 输出 JSONL 事件流;usage 在 `turn.completed.usage`(input/cached_input/cache_write_input/output/reasoning_output)。**已确认:usage 是线程累计值**(resume 后 output_tokens 5→11)。每轮新开线程则等于单轮;resume 需做差。`-o` 写最终消息到文件;`--output-schema` 可要求结构化输出。
- dsh(@deepseek-ai/dsh 0.2.2-rc.1):`dsh --profile headless --json` 输出 JSONL;**`status.step_end` 事件带每步 usage**(inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens),求和即单次运行用量。非 JSON 模式才没有 usage。`final` 事件带最终文本与 reason.kind。rc 阶段,适配器标高维护。

## 1. 已定决策

- 目标:省 API 钱,透明地"掺沙子"。不做订阅额度轮转。
- 边界:插件只做路由(含重派/升级决策)。任务拆分、上下文组装、派发、验收归 host。
- 架构:策略即分类器(端到端,结构化配置渲染成 prompt);路由模型可换、不评估、只记 id。
- 评估:独立的固定分析标注器做分层;交错随机分配,后续 bandit;先报告后自动调整。
- 存储:SQLite(WAL),JSONL/OTel 仅导出。
- 代码分层:无宿主依赖的核心 CLI+库;每宿主一个薄适配器包,负责市场打包。
- host 接口:机制固定(skill 调 `evener decide` / `evener report`,Stop/SubagentStop hooks 兜底),行为可配置。

## 2. 任务生命周期事件 schema(第 6 项)

```yaml
# 共享头部
event_id: uuid
task_id: uuid
round: int            # 从 1 开始,每次重派 +1
ts: iso8601
host: claude-code
host_session_id: string
policy_version: string   # 当前生效策略的内容哈希
schema_version: 1

task.created:
  description_hash: sha256
  description_excerpt: string   # 可选,前 200 字,可关
  repo_fingerprint: sha256
  pre_features: {description_chars: int, files_mentioned: int, repo_files: int}
  analysis_label: enum          # 分析标注器,固定分类法
  constraints: [string]

route.decided:
  target: codex | dsh | host
  candidates: [{target, score}]
  rationale: string
  router_model: string
  router_latency_ms: int
  router_cost_usd: float
  arm: A | B | null
  escalated_from: target | null

dispatch.started:
  target: enum
  target_version: string
  model: string
  context_bytes: int

dispatch.finished:
  status: success | error | timeout | budget_exceeded
  wall_ms: int
  usage: {input, cached_input, output, reasoning}
  cost_usd: float
  price_table_version: string
  diff_stats: {files, insertions, deletions}   # 结果指标,不做基线
  tool_calls: int

acceptance.finished:
  verdict: accepted | rejected
  checks: [{name: tests|lint|build|scope, result: pass|fail|skipped}]
  review_verdict: pass | fail | skipped
  reject_reason: tests_failed | build_failed | out_of_scope | incomplete | style | misunderstood | regression | other
  reviewer_cost_usd: float
  reviewer_wall_ms: int

task.redispatch:
  reason: enum
  context_delta: added | modified | unchanged
  next_target: enum

task.closed:
  outcome: accepted | handed_to_human | abandoned
  total_rounds: int
  total_cost_usd: float   # 所有轮次 + 所有验收
  total_wall_ms: int

user.feedback: {rating: up | down, comment: string}
user.override: {from: enum, to: enum}
post.revert: {days_after: int, reverted_ratio: float}
```

## 3. 策略配置 schema(第 7 项)

```yaml
schema_version: 1
policy_name: default

router:
  model: jev-1.13 | any-openai-compatible
  endpoint: ...
  api_key_env: ROUTER_API_KEY
  timeout_ms: 3000
  fallback: static_table

taxonomy:
  labels: [bugfix, feature, refactor, test, docs, mechanical, question]

targets:
  host:  {description: 当前会话自己做, cost_tier: high, enabled: true}
  codex:
    description: OpenAI Codex CLI
    command: codex exec --json --sandbox workspace-write --approve-for-me
    api_key_env: OPENAI_API_KEY
    cost_tier: mid
    strengths: [bugfix, feature, test]
    enabled: true
  dsh:
    description: DeepSeek Harness
    command: npx @deepseek-ai/dsh --profile headless
    api_key_env: DEEPSEEK_API_KEY
    cost_tier: low
    strengths: [mechanical, docs, test]
    weaknesses: [refactor]
    enabled: true

rules:   # 硬规则,先于模型判断
  - {if: {constraint: private_path}, then: host, locked: true}
  - {if: {label: question}, then: host}
  - {if: {pre_features.files_mentioned: ">= 8"}, then: host}

preferences:   # 软偏好,渲染进 prompt,可自动调
  cost_weight: 0.6
  quality_weight: 0.4
  per_label_bias:
    mechanical: {dsh: 0.8, codex: 0.2}
    refactor:   {host: 0.6, codex: 0.3, dsh: -0.5}

escalation:
  chain: [dsh, codex, host]
  retry_same_target_once: true
  escalate_on_reasons: [misunderstood, incomplete, regression]
  never_escalate_on: [style]

limits:
  max_rounds_per_task: 3
  max_cost_per_task_usd: 2.00
  max_wall_per_round_s: 900

privacy:
  store_description_excerpt: false
  private_paths: ["**/secrets/**", "**/.env*"]
  never_delegate_repos: []

experiment:
  mode: off | interleave | bandit
  arms: {A: policy-a.yaml, B: policy-b.yaml}
  assignment: random | by_label_stratified
```

## 4. 质量信号(第 8 项)

| 级别 | 信号 | 来源 | 成本 | 第一版 |
|---|---|---|---|---|
| L0 机械 | 首次通过率、平均轮次、验收检查逐项通过率 | acceptance | 零 | 必做 |
| L1 人工 | 👍/👎、用户改派、人工接手率 | user.*、task.closed | 零 | 必做 |
| L2 延迟 | 7 天回滚率 | post.revert | 低 | 可选 |
| L3 评审 | 模型评审分 | acceptance.review | 中 | 不做 |

质量分默认权重:首次通过 0.4 / 最终通过 0.2 / 👍👎 0.3 / 回滚率 0.1;无用户反馈时 0.3 按比例分给前两项。
style 驳回占某目标总驳回 >50% 时标"疑似评审偏好",不扣分。

核心复合指标:
- CPAT(单位已验收任务成本)=(全部轮次成本 + 全部验收成本)/ 已验收任务数
- 性价比 = 质量分 / CPAT

## 5. 报告规格(第 9 项)

`evener report [--since 14d] [--by label]`,默认每周生成到本地文件。
1. 头部:时间窗、任务总数、各臂任务数、策略版本
2. 总表:每臂 CPAT、质量分、性价比、平均耗时,90% 区间
3. 分层表:按 analysis_label 展开;样本 <8 的格子显示"样本不足"
4. 目标画像:首次通过率、驳回原因分布、平均成本/耗时、故障率、网络延迟
5. 可检出差异:当前样本量与方差下的最小可检出性价比差异
6. 建议:≤3 条,每条对应一个具体字段与建议值,附依据与 `evener apply <n>`

## 6. 成功指标(第 10 项,按"可区分"定义)

典型个人用量下,四周内若两套策略性价比真实差异 ≥25%,报告以 90% 置信度检出;"最小可检出差异"随样本增长单调收窄。
非功能需求:按标签分层、成本取对数后比较(任务成本 CV 通常 ≥1,否则每臂需数百任务)。25%/90% 为待校准值。

## 7. 护栏默认值(第 11 项)

| 项 | 默认 | 触发后 |
|---|---|---|
| 每任务最大轮次 | 3 | 人工接手 |
| 每任务预算 | $2.00 | 人工接手 |
| 单轮超时 | 15 min | 记 timeout,按驳回处理 |
| 验收开销占比告警 | 单任务 >30% 或周均 >20% | 报告头部告警 |
| 路由模型超时 | 3 s | 退回静态规则表 |
| 目标连续故障 | 3 次 | 熔断 30 min |
| 同目标同原因重复驳回 | 2 次 | 强制升级 |
| 日预算 | 不设 | 用户可开 |

## 8. 冷启动默认策略表(第 12 项)

价格排序(低→高):DeepSeek、OpenAI、Anthropic;价格表为配置项。

| 任务类别 | 首选 | 升级链 | 理由 |
|---|---|---|---|
| mechanical(批量改名/迁移/格式化/样板) | dsh | codex → host | 纯执行 |
| docs | dsh | codex | 容忍度高 |
| test | dsh | codex → host | 机械验收现成 |
| bugfix 单文件有复现 | codex | host | 中档推理 |
| bugfix 跨文件无复现 | host | 无 | 探索性 |
| feature 小、范围明确 | codex | host | |
| feature 大、涉及设计 | host | 无 | 不委派 |
| refactor 单文件 | codex | host | |
| refactor 跨文件 | host | 无 | 验收难 |
| question | host | 无 | 无产物可验收 |

## 9. 非目标

不做任务拆分、不组装上下文、不做验收、不做 token 代理、不做订阅额度轮转。本地只读 Web 面板（spec §13）于 2026-11-09 纳入 v1（D22）；不做宿主内嵌 GUI。

## 10. 待验证假设

- 分类结果与路由模型选择无关(日志记 router_model 备查)
- 验收开销占比可控(<20%)
- 随机交错下无需稳态假设

## 11. 待办 spike(已完成 2026-11-09)

1. ~~本机跑 `codex exec --json`,确认 usage 语义~~ → 线程累计
2. ~~找 dsh usage~~ → `headless --json` 的 `step_end.usage`,无需 sdk profile

实现规格见 `design/spec-v1.md`;留给用户的决定见 `design/decisions-for-user.md`。
