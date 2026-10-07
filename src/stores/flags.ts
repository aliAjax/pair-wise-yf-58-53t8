import { defineStore } from 'pinia';

/* ---------------------------------- 类型 ---------------------------------- */

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back' | 'invalidated';
export type PlanState = 'effective' | 'invalidated';
export type EvalResult = 'effective' | 'invalidated';

export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  rollout: number;
  rules: RuleSet;
  status: FlagStatus;
  /** 前置（父）开关 id 列表：本开关只有在前置开关命中时才可能命中 */
  dependencies: string[];
  /** 乐观锁版本：依赖/放量提交必须携带它读取时的版本 */
  rev: number;
  updatedAt: string;
  updatedBy: string;
}
export interface RolloutPlan {
  id: string;
  flagId: string;
  scheduledAt: string;
  approvals: string[];
  version: number;
  /** effective=已生效（审批结果有效）；invalidated=因上游改动已失效，需重新审批 */
  state: PlanState;
  invalidReason?: string;
  rev: number;
}
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }

export interface SampleUser { id: string; region: string; appVersion: string; authenticated: boolean; }
export interface ChainNodeResult { flagId: string; key: string; name: string; passed: boolean; reason?: string; }
export interface FlagEvaluation {
  flagId: string;
  result: EvalResult;
  total: number;
  hitCount: number;
  hitUserIds: string[];
  chain: string[];
  rejectReason?: string;
  planVersion: number;
  computedAt: string;
}
export interface RecomputeItem { flagId: string; done: boolean; }
export interface RecomputeTask {
  id: string;
  reason: string;
  triggeredBy: string;
  createdAt: string;
  finishedAt?: string;
  /** 待重算开关（已按依赖拓扑排序），逐项推进 */
  items: RecomputeItem[];
  /** 断点：下一个待处理 item 的下标，每次落盘检查点后推进 */
  cursor: number;
  status: 'running' | 'failed' | 'done';
  /** 刷新导致的中断（启动时自动从断点继续） */
  interrupted?: boolean;
  lastError?: string;
  /** 演练用：下一次写检查点时失败 */
  failNextWrite?: boolean;
}

export interface SimulationResult {
  hit: boolean;
  reason: string;
  chain: ChainNodeResult[];
}
export interface CycleDetail { cycleIds: string[]; cycleLabels: string[]; }
export interface SaveResult {
  ok: boolean;
  conflict?: { field: 'dependencies' | 'rollout'; expectedRev: number; serverRev: number; serverValue: unknown; };
  cycle?: CycleDetail;
  error?: string;
}

/* --------------------------------- 固定样本 -------------------------------- */

/** 命中范围重算所用的确定性用户样本 */
export const SAMPLE_USERS: SampleUser[] = [
  { id: 'user-1001', region: '上海', appVersion: '8.3.0', authenticated: true },
  { id: 'user-1002', region: '上海', appVersion: '8.2.1', authenticated: true },
  { id: 'user-1003', region: '北京', appVersion: '8.3.0', authenticated: true },
  { id: 'user-1004', region: '广东', appVersion: '8.1.5', authenticated: false },
  { id: 'user-1005', region: '上海', appVersion: '7.9.0', authenticated: true },
  { id: 'user-1006', region: '北京', appVersion: '8.0.0', authenticated: false },
  { id: 'user-1007', region: '广东', appVersion: '8.3.0', authenticated: true },
  { id: 'user-1008', region: '上海', appVersion: '8.3.0', authenticated: false },
  { id: 'user-1009', region: '北京', appVersion: '8.4.0', authenticated: true },
  { id: 'user-1010', region: '广东', appVersion: '8.2.0', authenticated: true },
  { id: 'user-1011', region: '上海', appVersion: '8.4.1', authenticated: true },
  { id: 'user-1012', region: '北京', appVersion: '8.3.0', authenticated: true }
];

/* --------------------------------- 图算法 ---------------------------------- */

function depsMapFrom(flags: Pick<FeatureFlag, 'id' | 'dependencies'>[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of flags) map.set(f.id, [...f.dependencies]);
  return map;
}

/** DFS 后序展开依赖链（前置在前，自身在末），同时回传遇到的环 */
export function resolveChain(depsOf: Map<string, string[]>, rootId: string): { order: string[]; cycle: string[] | null } {
  const order: string[] = [];
  const finished = new Set<string>();
  const onPath = new Set<string>();
  let cycle: string[] | null = null;
  const visit = (id: string, path: string[]) => {
    if (cycle) return;
    if (onPath.has(id)) { cycle = [...path.slice(path.indexOf(id)), id]; return; }
    if (finished.has(id)) return;
    onPath.add(id);
    for (const dep of depsOf.get(id) ?? []) visit(dep, [...path, id]);
    onPath.delete(id);
    finished.add(id);
    order.push(id);
  };
  visit(rootId, []);
  return { order, cycle };
}

/** 假定 origin 的依赖换成 nextDeps，检查是否形成环路 */
export function detectCycle(flags: FeatureFlag[], originId: string, nextDeps: string[]): string[] | null {
  const map = depsMapFrom(flags);
  map.set(originId, [...nextDeps]);
  const { cycle } = resolveChain(map, originId);
  return cycle;
}

/** 反向图 BFS：origin 改动后受影响的全部子孙开关（按层级，父在子前） */
export function descendants(flags: FeatureFlag[], originIds: string[]): string[] {
  const reverse = new Map<string, string[]>();
  for (const f of flags) for (const dep of f.dependencies) {
    const list = reverse.get(dep) ?? [];
    list.push(f.id);
    reverse.set(dep, list);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = [...originIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of reverse.get(id) ?? []) {
      if (!seen.has(child)) { seen.add(child); out.push(child); queue.push(child); }
    }
  }
  return out;
}

/* -------------------------------- 规则计算 --------------------------------- */

function hashBucket(...parts: string[]): number {
  return [...parts.join('|')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 100;
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function versionSatisfies(userVersion: string, rule: string): boolean {
  const m = rule.trim().match(/^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+)*)$/);
  if (!m) return true;
  const cmp = compareVersion(userVersion, m[2]);
  switch (m[1] ?? '>=') {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '=': return cmp === 0;
    default: return true;
  }
}

/** 单个开关节点对单个用户的判定（不含依赖）；isSelf 决定文案主语 */
function evalNode(flag: FeatureFlag, user: SampleUser, isSelf: boolean): string | null {
  const who = isSelf ? '' : `前置开关「${flag.name}」`;
  if (!flag.enabled) return isSelf ? '开关未启用' : `${who}已停用`;
  if (flag.rules.region !== '全部' && flag.rules.region !== user.region) {
    return isSelf ? `地区不匹配（要求${flag.rules.region}）` : `${who}地区不匹配（要求${flag.rules.region}）`;
  }
  if (flag.rules.authenticated && !user.authenticated) return isSelf ? '要求已登录用户' : `${who}要求已登录`;
  if (!versionSatisfies(user.appVersion, flag.rules.appVersion)) {
    return isSelf ? `版本不满足（要求 ${flag.rules.appVersion}）` : `${who}版本不满足（要求 ${flag.rules.appVersion}）`;
  }
  const bucket = hashBucket(flag.key, user.id);
  if (bucket >= flag.rollout) {
    return isSelf ? `灰度桶 ${bucket} ≥ ${flag.rollout}%` : `${who}灰度桶未命中（${bucket} ≥ ${flag.rollout}%）`;
  }
  return null;
}

/* ---------------------------------- 状态 ----------------------------------- */

interface State {
  schema: number;
  flags: FeatureFlag[];
  plans: RolloutPlan[];
  audit: AuditRecord[];
  evaluations: Record<string, FlagEvaluation>;
  tasks: RecomputeTask[];
  activeId: string;
}

const STORAGE_KEY = 'yf58-flag-state-v2';
const SCHEMA_VERSION = 2;
const now = () => new Date().toLocaleString('zh-CN', { hour12: false });

function seed(): State {
  const flags: FeatureFlag[] = [
    { id: 'f3', name: '支付链路 V3', key: 'payment-v3', enabled: true, rollout: 100, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', dependencies: [], rev: 1, updatedAt: '', updatedBy: '系统' },
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', dependencies: ['f3'], rev: 3, updatedAt: '', updatedBy: '系统' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', dependencies: [], rev: 2, updatedAt: '', updatedBy: '系统' },
    { id: 'f4', name: '首页个性化推荐', key: 'home-personalize', enabled: true, rollout: 60, rules: { region: '全部', appVersion: '>= 8.1', authenticated: false }, status: 'rolling', dependencies: ['f2'], rev: 1, updatedAt: '', updatedBy: '系统' }
  ];
  const plans: RolloutPlan[] = [
    { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: [], version: 3, state: 'effective', rev: 3 },
    { id: 'p2', flagId: 'f2', scheduledAt: '2026-10-02T10:00', approvals: ['产品负责人', '研发负责人'], version: 2, state: 'effective', rev: 2 },
    { id: 'p4', flagId: 'f4', scheduledAt: '2026-10-02T10:00', approvals: ['产品负责人', '研发负责人'], version: 1, state: 'effective', rev: 1 }
  ];
  return {
    schema: SCHEMA_VERSION,
    activeId: 'f1',
    flags,
    plans,
    evaluations: {},
    tasks: [],
    audit: [
      { id: 'a1', at: now(), actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
      { id: 'a2', at: now(), actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
    ]
  };
}

function readRaw(): State | null {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as State;
    if (parsed.schema !== SCHEMA_VERSION || !Array.isArray(parsed.flags)) return null;
    return parsed;
  } catch { return null; }
}

/** 刷新后：仍在 running 的任务视为被刷新打断，标记可从断点继续 */
function markInterrupted(state: State): State {
  for (const task of state.tasks) {
    if (task.status === 'running') {
      task.status = 'failed';
      task.interrupted = true;
      task.lastError = '页面刷新中断了重算，进度已保留在断点，可从断点继续重试';
    }
  }
  return state;
}

function load(): State {
  const raw = readRaw();
  return raw ? markInterrupted(raw) : seed();
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 重算任务串行执行链，避免多个任务并发写检查点互相干扰 */
let runChain: Promise<void> = Promise.resolve();
function enqueueRun(store: ReturnType<typeof useFlagStore>, taskId: string) {
  runChain = runChain.then(() => store.runTask(taskId)).catch(() => undefined);
}

/* ---------------------------------- Store ---------------------------------- */

export const useFlagStore = defineStore('flags', {
  state: (): State => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    flagById(state): (id: string) => FeatureFlag | undefined { return (id: string) => state.flags.find((f) => f.id === id); },
    planByFlag(state): (id: string) => RolloutPlan | undefined { return (id: string) => state.plans.find((p) => p.flagId === id); },
    activeTask(state): RecomputeTask | undefined { return state.tasks.find((t) => t.status === 'running' || t.status === 'failed'); }
  },
  actions: {
    /* ------------------------------ 基础 ------------------------------ */
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    /** 其它标签页写入后同步本页数据；打开中的编辑会话保留自己的 expectedRev，提交时自然报冲突 */
    reloadFromStorage() {
      const raw = readRaw();
      if (!raw) return;
      // 外部刚写入的 running 任务本页不接管，避免两个标签页重复执行
      this.$patch(raw as Partial<State>);
    },
    recordAudit(action: string, detail: string, actor = '当前操作人') {
      this.audit.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: now(), actor, action, detail });
      this.persist();
    },
    select(id: string) { this.activeId = id; this.persist(); },
    touch(flag: FeatureFlag, actor: string) { flag.rev += 1; flag.updatedAt = now(); flag.updatedBy = actor; },

    /* --------------------------- 级联失效/重算 -------------------------- */
    /**
     * 父开关改动后：
     * 1. 全部子孙开关中仍“生效中”的计划立即置为 invalidated（保留原对象与旧审批痕迹，清除审批待重新会签）；
     * 2. 正在放量的子孙开关立即停止按自身比例命中；
     * 3. 为受影响开关创建可断点续跑的命中范围重算任务。
     */
    cascade(originIds: string[], includeOrigin: boolean, reason: string, actor: string) {
      const originSet = new Set(originIds);
      const down = descendants(this.flags, originIds).filter((id) => !originSet.has(id));
      const targets = includeOrigin ? [...new Set([...originIds, ...down])] : down;
      if (!targets.length) return;

      const invalidatedNames: string[] = [];
      for (const id of targets) {
        const flag = this.flagById(id);
        const plan = this.planByFlag(id);
        if (!flag) continue;
        const isDescendant = !originSet.has(id);
        const live = flag.enabled || ['approved', 'rolling', 'scheduled'].includes(flag.status);
        if (plan && plan.state === 'effective' && live) {
          plan.state = 'invalidated';
          plan.invalidReason = reason;
          plan.approvals = [];
          plan.rev += 1;
          if (isDescendant) {
            // 子孙：立即停止按自身比例命中
            flag.enabled = false;
            flag.status = 'invalidated';
          } else if (!['stopped', 'rolled-back'].includes(flag.status)) {
            // 改动开关自身：只回到草稿，不强制停用
            flag.status = 'draft';
          }
          invalidatedNames.push(flag.key);
        }
      }

      if (invalidatedNames.length) {
        this.audit.unshift({
          id: `a-${Date.now()}-c`, at: now(), actor,
          action: '计划级联失效',
          detail: `${reason}；已失效：${invalidatedNames.join('、')}`
        });
      }

      // 去重：已在未完成任务里的开关不重复入队
      const pending = new Set<string>();
      for (const t of this.tasks) if (t.status !== 'done') for (const item of t.items) pending.add(item.flagId);
      const queued = targets.filter((id, idx) => targets.indexOf(id) === idx && !pending.has(id));
      if (queued.length) {
        const task: RecomputeTask = {
          id: `t-${Date.now()}`,
          reason,
          triggeredBy: actor,
          createdAt: now(),
          items: queued.map((id) => ({ flagId: id, done: false })),
          cursor: 0,
          status: 'running'
        };
        this.tasks.unshift(task);
        this.recordAudit('创建重算任务', `${reason}；${queued.length} 个开关等待重算`, actor);
        this.persist();
        enqueueRun(this, task.id);
      } else {
        this.persist();
      }
    },

    /** 重算任务执行：按批次推进，每批落一次检查点；失败时 cursor 不前移 */
    async runTask(taskId: string) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task || task.status === 'done') return;
      task.status = 'running';
      task.interrupted = false;
      this.persist();
      const BATCH = 2;
      while (task.cursor < task.items.length) {
        // 模拟写入失败：检查点无法落盘，进度停在当前断点，等待重试
        if (task.failNextWrite) {
          task.failNextWrite = false;
          task.status = 'failed';
          task.lastError = '写入失败：检查点无法落盘（模拟存储故障），进度停留在断点，可重试';
          this.persist();
          return;
        }
        const slice = task.items.slice(task.cursor, task.cursor + BATCH);
        for (const item of slice) {
          this.evaluations[item.flagId] = this.computeEvaluation(item.flagId);
          item.done = true;
        }
        task.cursor += slice.length;
        await delay(260); // 放大批处理过程，便于观察进度
        this.persist(); // 断点检查点
      }
      task.status = 'done';
      task.finishedAt = now();
      task.lastError = undefined;
      this.persist();
    },
    /** 从断点继续重试（刷新中断或写入失败后调用） */
    resumeTask(taskId: string) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task || task.status !== 'failed') return;
      task.lastError = undefined;
      task.interrupted = false;
      this.persist();
      enqueueRun(this, task.id);
    },
    armWriteFailure(taskId: string) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (task) { task.failNextWrite = true; this.persist(); }
    },

    /** 计算单个开关在全量样本下的命中范围与最终依赖链 */
    computeEvaluation(flagId: string): FlagEvaluation {
      const flag = this.flagById(flagId);
      const plan = this.planByFlag(flagId);
      const fallback: FlagEvaluation = {
        flagId, result: 'invalidated', total: SAMPLE_USERS.length, hitCount: 0, hitUserIds: [],
        chain: [], rejectReason: '开关不存在', planVersion: plan?.version ?? 0, computedAt: now()
      };
      if (!flag) return fallback;

      const sim = this.simulateHit(flagId, SAMPLE_USERS[0]); // 取链路结构与链路级拒绝原因
      const chainIds = sim.chain.map((n) => n.flagId);

      // 链路级失效：存在环
      if (sim.chain.some((n) => n.reason?.includes('环路'))) {
        return {
          flagId, result: 'invalidated', total: SAMPLE_USERS.length, hitCount: 0, hitUserIds: [],
          chain: chainIds, rejectReason: sim.reason, planVersion: plan?.version ?? flag.rev, computedAt: now()
        };
      }
      // 链路级失效：链上（含自身）有停用节点
      const disabledNode = sim.chain.find((n) => !n.passed && n.reason && (n.reason.includes('停用') || n.reason.includes('未启用')));
      // 计划已被级联失效
      const planInvalid = plan?.state === 'invalidated';
      if (disabledNode || planInvalid) {
        const rejectReason = planInvalid
          ? `${plan?.invalidReason ?? '上游改动'}；${disabledNode?.reason ?? '计划已失效，需重新审批'}`
          : disabledNode!.reason!;
        return {
          flagId, result: 'invalidated', total: SAMPLE_USERS.length, hitCount: 0, hitUserIds: [],
          chain: chainIds, rejectReason, planVersion: plan?.version ?? flag.rev, computedAt: now()
        };
      }

      const hitUserIds: string[] = [];
      for (const user of SAMPLE_USERS) {
        const r = this.simulateHit(flagId, user);
        if (r.hit) hitUserIds.push(user.id);
      }
      return {
        flagId,
        result: 'effective',
        total: SAMPLE_USERS.length,
        hitCount: hitUserIds.length,
        hitUserIds,
        chain: chainIds,
        planVersion: plan?.version ?? flag.rev,
        computedAt: now()
      };
    },

    /** 启动恢复：刷新前没跑完的任务自动从断点继续 */
    bootResume() {
      for (const task of this.tasks) {
        if (task.status === 'failed' && task.interrupted && task.cursor < task.items.length) enqueueRun(this, task.id);
      }
      // 首次进入：给现有开关补一份基线评估
      if (!Object.keys(this.evaluations).length) {
        for (const f of this.flags) this.evaluations[f.id] = this.computeEvaluation(f.id);
        this.persist();
      }
    },

    /* ------------------------------ 编辑动作 ----------------------------- */
    updateRule(rule: Partial<RuleSet>, actor = '当前操作人') {
      if (!this.active) return;
      this.active.rules = { ...this.active.rules, ...rule };
      this.active.status = 'draft';
      const plan = this.activePlan;
      if (plan) { plan.approvals = []; plan.rev += 1; }
      this.touch(this.active, actor);
      this.recordAudit('修改规则', JSON.stringify(this.active.rules), actor);
      this.cascade([this.active.id], true, `上游开关 ${this.active.key} 规则发生变更`, actor);
    },

    /** 放量提交带乐观锁：expectedRev 过期则冲突，先前结果原样保留 */
    saveRollout(flagId: string, value: number, expectedRev: number, actor = '当前操作人'): SaveResult {
      const flag = this.flagById(flagId);
      if (!flag) return { ok: false, error: '开关不存在' };
      if (flag.rev !== expectedRev) {
        return { ok: false, conflict: { field: 'rollout', expectedRev, serverRev: flag.rev, serverValue: flag.rollout } };
      }
      const previous = flag.rollout;
      flag.rollout = value;
      this.touch(flag, actor);
      this.recordAudit('调整放量', `${flag.key}：${previous}% → ${value}%`, actor);
      this.cascade([flagId], false, `上游开关 ${flag.key} 放量比例变更为 ${value}%`, actor);
      return { ok: true };
    },

    /** 保存依赖：自依赖/环路拦截（指出涉及开关），并带乐观锁冲突检测 */
    saveDependencies(flagId: string, nextDeps: string[], expectedRev: number, actor = '当前操作人'): SaveResult {
      const flag = this.flagById(flagId);
      if (!flag) return { ok: false, error: '开关不存在' };
      const deps = [...new Set(nextDeps.filter(Boolean))];
      if (deps.includes(flagId)) return { ok: false, error: '不能将开关自身设为前置开关' };
      for (const dep of deps) if (!this.flagById(dep)) return { ok: false, error: '前置开关不存在，请刷新后重试' };

      const cycleIds = detectCycle(this.flags, flagId, deps);
      if (cycleIds) {
        const labels = cycleIds.map((id) => {
          const f = this.flagById(id);
          return f ? `${f.name}（${f.key}）` : id;
        });
        return { ok: false, cycle: { cycleIds, cycleLabels: labels } };
      }
      if (flag.rev !== expectedRev) {
        return { ok: false, conflict: { field: 'dependencies', expectedRev, serverRev: flag.rev, serverValue: [...flag.dependencies] } };
      }
      const before = flag.dependencies.map((id) => this.flagById(id)?.key ?? id).join('、') || '无';
      const after = deps.map((id) => this.flagById(id)?.key ?? id).join('、') || '无';
      flag.dependencies = deps;
      this.touch(flag, actor);
      this.recordAudit('修改依赖', `${flag.key}：[${before}] → [${after}]`, actor);
      this.cascade([flagId], true, `上游开关 ${flag.key} 的依赖关系发生变更`, actor);
      return { ok: true };
    },

    setEnabled(flagId: string, enabled: boolean, actor = '当前操作人') {
      const flag = this.flagById(flagId);
      if (!flag || flag.enabled === enabled) return;
      flag.enabled = enabled;
      this.touch(flag, actor);
      if (!enabled) flag.status = 'stopped';
      this.recordAudit(enabled ? '启用开关' : '停用开关', `${flag.key} 已${enabled ? '启用' : '停用'}`, actor);
      this.cascade([flagId], false, `上游开关 ${flag.key} 已${enabled ? '重新启用' : '停用'}`, actor);
    },

    schedule(value: string, actor = '当前操作人') {
      if (!this.active || !this.activePlan) return;
      this.activePlan.scheduledAt = value;
      this.active.status = 'scheduled';
      this.activePlan.rev += 1;
      this.recordAudit('设置定时', `${this.active.key} 于 ${value} 生效`, actor);
    },

    /** 重新审批会让已失效计划重新变为生效；两次会签后才可发布 */
    approve(role: string, actor = role) {
      if (!this.active || !this.activePlan) return;
      const plan = this.activePlan;
      if (plan.state === 'invalidated') {
        // 首轮重新审批 = 重新确认计划：清空失效痕迹，开启新一轮会签
        plan.state = 'effective';
        plan.invalidReason = undefined;
        plan.approvals = [role];
        plan.version += 1;
        plan.rev += 1;
        this.active.status = 'draft';
      } else {
        if (plan.approvals.includes(role)) return;
        plan.approvals.push(role);
        if (plan.approvals.length >= 2) this.active.status = 'approved';
      }
      this.recordAudit('审批发布', `${role} 已确认 ${this.active.key}（计划 v${plan.version}，${plan.state === 'effective' ? '已生效' : '已失效'}）`, actor);
      this.persist();
    },
    startRollout(actor = '当前操作人') {
      if (!this.active || !this.activePlan) return;
      if (this.activePlan.state !== 'effective' || this.activePlan.approvals.length < 2) return;
      this.active.enabled = true;
      this.active.status = 'rolling';
      this.touch(this.active, actor);
      this.recordAudit('开始放量', `${this.active.key} 启用 ${this.active.rollout}%`, actor);
      this.cascade([this.active.id], false, `上游开关 ${this.active.key} 开始放量`, actor);
    },
    emergencyStop(actor = '当前操作人') {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.status = 'stopped';
      this.touch(this.active, actor);
      this.recordAudit('紧急停止', `${this.active.key} 已立即关闭`, actor);
      this.cascade([this.active.id], false, `上游开关 ${this.active.key} 被紧急停止`, actor);
    },
    rollback(actor = '当前操作人') {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.rollout = 0;
      this.active.status = 'rolled-back';
      this.touch(this.active, actor);
      this.recordAudit('执行回滚', `${this.active.key} 回滚至关闭状态`, actor);
      this.cascade([this.active.id], false, `上游开关 ${this.active.key} 执行回滚`, actor);
    },

    /* ------------------------------ 命中模拟 ----------------------------- */
    /**
     * 沿最终采用的依赖链逐节点判定：
     * 前置节点（DFS 后序、前置在前自身在末）任一不通过即拒绝，并给出拒绝原因。
     */
    simulateHit(flagId: string, user: SampleUser): SimulationResult {
      const depsOf = depsMapFrom(this.flags);
      const { order, cycle } = resolveChain(depsOf, flagId);
      const chain: ChainNodeResult[] = [];
      if (cycle) {
        const labels = cycle.map((id) => this.flagById(id)?.key ?? id).join(' → ');
        for (const id of order) {
          const f = this.flagById(id);
          if (f) chain.push({ flagId: id, key: f.key, name: f.name, passed: false, reason: '依赖存在环路' });
        }
        return { hit: false, reason: `依赖存在环路，拒绝放行：${labels}`, chain };
      }
      for (const id of order) {
        const f = this.flagById(id);
        if (!f) { chain.push({ flagId: id, key: id, name: id, passed: false, reason: '开关不存在' }); continue; }
        const isSelf = id === flagId;
        const fail = evalNode(f, user, isSelf) ?? undefined;
        if (fail) {
          chain.push({ flagId: id, key: f.key, name: f.name, passed: false, reason: isSelf && fail === '开关本身已停用' ? '开关未启用' : fail });
        } else {
          chain.push({ flagId: id, key: f.key, name: f.name, passed: true });
        }
      }
      const firstReject = chain.find((node) => !node.passed);
      if (firstReject) {
        const suffix = firstReject.flagId === flagId
          ? firstReject.reason
          : `被前置开关「${firstReject.name}」拒绝：${firstReject.reason}`;
        return { hit: false, reason: suffix ?? '未命中', chain };
      }
      const selfFlag = this.flagById(flagId);
      const bucket = selfFlag ? hashBucket(selfFlag.key, user.id) : -1;
      return { hit: true, reason: `依赖链全部通过，灰度桶 ${bucket} < ${selfFlag?.rollout ?? 0}%，命中新功能`, chain };
    }
  }
});
