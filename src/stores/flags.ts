import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export type PlanState = 'draft' | 'effective' | 'invalid';
export type TaskStatus = 'pending' | 'running' | 'failed' | 'done';

export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; dependsOn: string[]; version: number; }
export interface RolloutPlan { id: string; flagId: string; scheduledAt: string; approvals: string[]; version: number; state: PlanState; invalidReason?: string; invalidatedAt?: string; effectiveAt?: string; }
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }
export interface RecalcTask { id: string; flagId: string; planId: string; reason: string; status: TaskStatus; total: number; processed: number; hitCount: number; failCount: number; updatedAt: string; }
export interface ChainNode { id: string; key: string; name: string; passed: boolean; reason?: string; }
export interface SimResult { hit: boolean; reason: string; chain: ChainNode[]; }
export interface SimUser { id: string; region: string; appVersion: string; authenticated: boolean; }

interface State { flags: FeatureFlag[]; plans: RolloutPlan[]; audit: AuditRecord[]; activeId: string; recalcTasks: RecalcTask[]; running: boolean; }

const STORAGE_KEY = 'yf58-flag-state';
const CHUNK = 20;
const REGIONS = ['上海', '北京', '广东', '深圳'];

function buildUserPool(): SimUser[] {
  return Array.from({ length: 240 }, (_, index) => ({
    id: `u-${String(index + 1).padStart(4, '0')}`,
    region: REGIONS[index % REGIONS.length],
    appVersion: index % 5 === 0 ? '7.9.0' : '8.3.0',
    authenticated: index % 4 !== 0
  }));
}
const USER_POOL = buildUserPool();

function hashUser(id: string): number {
  return [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
}

function evalFlag(flag: FeatureFlag, user: SimUser): { passed: boolean; reason: string } {
  if (!flag.enabled) return { passed: false, reason: '开关已停用' };
  const rule = flag.rules;
  if (rule.region !== '全部' && rule.region !== user.region) return { passed: false, reason: `地区不匹配（要求${rule.region}，实际${user.region}）` };
  if (rule.authenticated && !user.authenticated) return { passed: false, reason: '要求已登录用户' };
  const bucket = hashUser(user.id);
  if (bucket >= flag.rollout) return { passed: false, reason: `灰度桶 ${bucket} ≥ ${flag.rollout}%` };
  return { passed: true, reason: `灰度桶 ${bucket} < ${flag.rollout}%` };
}

// 沿 dependsOn 自底向上构造依赖链（前置开关在前，当前开关在最后）
function buildChain(flags: FeatureFlag[], flagId: string): ChainNode[] {
  const nodes: ChainNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const flag = flags.find((item) => item.id === id);
    if (!flag) {
      nodes.push({ id, key: id, name: '缺失开关', passed: false, reason: '依赖的开关不存在' });
      return;
    }
    for (const dep of flag.dependsOn) walk(dep);
    nodes.push({ id: flag.id, key: flag.key, name: flag.name, passed: true });
  };
  walk(flagId);
  return nodes;
}

// 命中模拟：依赖链上任一前置开关未通过（停用 / 规则不符 / 灰度桶未中），当前开关即被拒绝
function simulate(flags: FeatureFlag[], flagId: string, user: SimUser): SimResult {
  const chain: ChainNode[] = [];
  let blocked = false;
  for (const node of buildChain(flags, flagId)) {
    if (blocked) {
      chain.push({ ...node, passed: false, reason: '前置未通过，未评估' });
      continue;
    }
    if (!node.passed) {
      chain.push(node);
      blocked = true;
      continue;
    }
    const flag = flags.find((item) => item.id === node.id);
    if (!flag) {
      chain.push({ ...node, passed: false, reason: '依赖的开关不存在' });
      blocked = true;
      continue;
    }
    const result = evalFlag(flag, user);
    chain.push({ ...node, passed: result.passed, reason: result.reason });
    if (!result.passed) blocked = true;
  }
  const failed = chain.find((node) => !node.passed && node.reason !== '前置未通过，未评估');
  if (failed) return { hit: false, reason: `依赖链在 ${failed.key} 处拒绝：${failed.reason}`, chain };
  return { hit: true, reason: '依赖链全部通过，命中新功能', chain };
}

// 环路检测：加入 fromId -> toId 的边后，若 toId 沿现有 dependsOn 能回到 fromId，即形成环
// 返回环上的开关 id 序列（fromId ... toId），否则 null
function cyclePath(flags: FeatureFlag[], fromId: string, toId: string): string[] | null {
  const prev = new Map<string, string | null>();
  prev.set(toId, null);
  const queue: string[] = [toId];
  while (queue.length) {
    const cur = queue.shift() as string;
    if (cur === fromId) {
      const path: string[] = [];
      let node: string | null = cur;
      while (node !== null) {
        path.push(node);
        node = prev.get(node) ?? null;
      }
      return path;
    }
    const flag = flags.find((item) => item.id === cur);
    for (const dep of flag?.dependsOn ?? []) {
      if (!prev.has(dep)) {
        prev.set(dep, cur);
        queue.push(dep);
      }
    }
  }
  return null;
}

// 所有直接或间接依赖 rootId 的开关（子开关、孙开关……）
function descendantsOf(flags: FeatureFlag[], rootId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const flag of flags) {
      if (!seen.has(flag.id) && flag.dependsOn.includes(cur)) {
        seen.add(flag.id);
        result.push(flag.id);
        queue.push(flag.id);
      }
    }
  }
  return result;
}

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'approved', dependsOn: ['f3', 'f4'], version: 1 },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', dependsOn: ['f3'], version: 1 },
    { id: 'f3', name: '支付通道 V3', key: 'payment-v3', enabled: true, rollout: 100, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', dependsOn: [], version: 1 },
    { id: 'f4', name: '会员体系 V2', key: 'member-v2', enabled: true, rollout: 100, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', dependsOn: [], version: 1 }
  ],
  plans: [
    { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: ['产品负责人', '研发负责人'], version: 3, state: 'effective', effectiveAt: '09:00' },
    { id: 'p2', flagId: 'f2', scheduledAt: '2026-09-28T10:00', approvals: ['产品负责人', '研发负责人'], version: 2, state: 'effective', effectiveAt: '09:02' },
    { id: 'p3', flagId: 'f3', scheduledAt: '2026-09-25T10:00', approvals: ['产品负责人', '研发负责人'], version: 1, state: 'effective', effectiveAt: '09:05' },
    { id: 'p4', flagId: 'f4', scheduledAt: '2026-09-26T10:00', approvals: ['产品负责人', '研发负责人'], version: 1, state: 'effective', effectiveAt: '09:06' }
  ],
  recalcTasks: [],
  running: false,
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ]
};

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const data = JSON.parse(saved) as Partial<State>;
    return {
      ...structuredClone(seed),
      ...data,
      flags: (data.flags ?? seed.flags).map((flag) => ({ ...flag, dependsOn: flag.dependsOn ?? [], version: flag.version ?? 1 })),
      plans: (data.plans ?? seed.plans).map((plan) => ({ ...plan, state: plan.state ?? 'effective' })),
      recalcTasks: data.recalcTasks ?? [],
      running: false
    };
  }
  return structuredClone(seed);
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); }
  },
  actions: {
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    keyOf(flagId: string) { return this.flags.find((item) => item.id === flagId)?.key ?? flagId; },
    addAudit(action: string, detail: string, actor = '当前操作人') {
      this.audit.unshift({ id: `a-${Date.now()}`, at: new Date().toLocaleTimeString(), actor, action, detail });
      this.persist();
    },
    select(id: string) { this.activeId = id; this.persist(); },
    // 多窗口场景：另一值班员在别的标签页提交后，本窗口通过 storage 事件感知并整体刷新
    reloadFromStorage() {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.$patch(JSON.parse(saved) as Partial<State>);
    },
    // 演示用：模拟另一值班员并发提交（版本号 +1），用于触发后提交者的冲突提示
    bumpVersion(flagId: string) {
      const flag = this.flags.find((item) => item.id === flagId);
      if (!flag) return;
      flag.version += 1;
      this.addAudit('并发模拟', `另一值班员提交了对 ${flag.key} 的修改（v${flag.version}）`);
    },
    // 保存依赖：baseVersion 为打开编辑时读到的版本，不一致说明被他人改过 → 冲突，先前结果保留
    setDependencies(flagId: string, deps: string[], baseVersion: number) {
      const flag = this.flags.find((item) => item.id === flagId);
      if (!flag) return;
      if (flag.version !== baseVersion) {
        throw { code: 'CONFLICT', message: '该开关已被其他值班员修改' };
      }
      for (const dep of deps) {
        if (dep === flagId) throw { code: 'CYCLE', cycle: [flag.key, flag.key] };
        const path = cyclePath(this.flags, flagId, dep);
        if (path) {
          const keys = path.map((id) => this.keyOf(id));
          throw { code: 'CYCLE', cycle: [...keys, flag.key] };
        }
      }
      flag.dependsOn = deps;
      flag.version += 1;
      this.addAudit('修改依赖', `${flag.key} 前置开关：${deps.map((id) => this.keyOf(id)).join('、') || '无'}`);
      this.persist();
      this.invalidateFor(flagId, '依赖关系变更');
    },
    setRollout(value: number, baseVersion?: number) {
      const flag = this.active;
      if (!flag) return;
      if (baseVersion !== undefined && flag.version !== baseVersion) {
        throw { code: 'CONFLICT', message: '放量已被其他值班员修改' };
      }
      flag.rollout = value;
      flag.version += 1;
      this.addAudit('调整放量', `${flag.key} → ${value}%`);
      this.persist();
      this.invalidateFor(flag.id, '放量调整');
    },
    updateRule(rule: Partial<RuleSet>) {
      if (!this.active) return;
      this.active.rules = { ...this.active.rules, ...rule };
      this.active.status = 'draft';
      this.activePlan && (this.activePlan.approvals = []);
      this.addAudit('修改规则', JSON.stringify(this.active.rules));
      this.persist();
      this.invalidateFor(this.active.id, '规则变更');
    },
    schedule(value: string) {
      if (!this.active || !this.activePlan) return;
      this.activePlan.scheduledAt = value;
      this.active.status = 'scheduled';
      this.addAudit('设置定时', `${this.active.key} 于 ${value} 生效`);
    },
    approve(role: string) {
      if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return;
      this.activePlan.approvals.push(role);
      this.active.status = this.activePlan.approvals.length >= 2 ? 'approved' : 'draft';
      this.addAudit('审批发布', `${role} 已确认 ${this.active.key}`, role);
      this.persist();
    },
    startRollout() {
      if (!this.active || this.active.status !== 'approved') return;
      this.active.enabled = true;
      this.active.status = 'rolling';
      this.addAudit('开始放量', `${this.active.key} 启用 ${this.active.rollout}%`);
      this.persist();
      this.invalidateFor(this.active.id, '开关启用');
    },
    emergencyStop() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.status = 'stopped';
      this.addAudit('紧急停止', `${this.active.key} 已立即关闭`);
      this.persist();
      this.invalidateFor(this.active.id, '紧急停止停用');
    },
    rollback() {
      if (!this.active) return;
      this.active.enabled = false;
      this.active.rollout = 0;
      this.active.status = 'rolled-back';
      this.addAudit('执行回滚', `${this.active.key} 回滚至关闭状态`);
      this.persist();
      this.invalidateFor(this.active.id, '回滚停用');
    },
    // 父开关变更：自身及所有子开关的计划立即失效，并创建可断点续算的重算任务
    invalidateFor(changedFlagId: string, reason: string) {
      const affected = [changedFlagId, ...descendantsOf(this.flags, changedFlagId)];
      const now = new Date().toLocaleTimeString();
      for (const id of affected) {
        const plan = this.plans.find((item) => item.flagId === id);
        if (!plan || plan.state === 'invalid') continue;
        plan.state = 'invalid';
        plan.invalidReason = `父开关变更：${reason}`;
        plan.invalidatedAt = now;
        this.recalcTasks.unshift({
          id: `t-${Date.now()}-${id}`,
          flagId: id,
          planId: plan.id,
          reason,
          status: 'pending',
          total: USER_POOL.length,
          processed: 0,
          hitCount: 0,
          failCount: 0,
          updatedAt: now
        });
      }
      this.addAudit('计划失效', `${reason} 导致 ${affected.length} 个开关的发布计划失效`);
      this.persist();
      this.pumpTasks();
    },
    pumpTasks() {
      if (this.running) return;
      const next = this.recalcTasks.find((task) => task.status === 'pending');
      if (next) void this.runTask(next.id);
    },
    async runTask(taskId: string) {
      const task = this.recalcTasks.find((item) => item.id === taskId);
      if (!task || task.status === 'done') return;
      this.running = true;
      task.status = 'running';
      task.updatedAt = new Date().toLocaleTimeString();
      this.persist();
      await new Promise((resolve) => setTimeout(resolve, 250));
      while (task.processed < task.total) {
        // 任务被外部置为 failed（人工标记）或 pending（刷新后被新循环接管）时，旧循环立即退出
        if (task.status !== 'running') return;
        // 模拟写入失败：断点保留在 processed，可从断点继续重试
        if (Math.random() < 0.16) {
          task.status = 'failed';
          task.failCount += 1;
          task.updatedAt = new Date().toLocaleTimeString();
          this.addAudit('重算写入失败', `${this.keyOf(task.flagId)} 断点 ${task.processed}/${task.total}，可继续重试`);
          this.persist();
          this.running = false;
          this.pumpTasks();
          return;
        }
        const start = task.processed;
        for (const user of USER_POOL.slice(start, start + CHUNK)) {
          if (simulate(this.flags, task.flagId, user).hit) task.hitCount += 1;
        }
        task.processed = start + CHUNK;
        task.updatedAt = new Date().toLocaleTimeString();
        this.persist();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      task.status = 'done';
      const latest = this.recalcTasks.find((item) => item.flagId === task.flagId && item.status !== 'done');
      const plan = this.plans.find((item) => item.id === task.planId);
      if (!latest && plan && plan.state === 'invalid') {
        plan.state = 'effective';
        plan.effectiveAt = new Date().toLocaleTimeString();
      }
      this.addAudit('命中范围重算完成', `${this.keyOf(task.flagId)}：${task.hitCount}/${task.total} 命中`);
      this.persist();
      this.running = false;
      this.pumpTasks();
    },
    // 刷新后恢复：未完成（pending/running）的任务从断点自动续算
    resumeTasks() {
      this.running = false;
      for (const task of this.recalcTasks) {
        if (task.status === 'pending' || task.status === 'running') task.status = 'pending';
      }
      this.persist();
      this.pumpTasks();
    },
    // 写入失败后手动续算：从断点继续，不重复已完成部分
    retryTask(taskId: string) {
      const task = this.recalcTasks.find((item) => item.id === taskId);
      if (!task || task.status !== 'failed') return;
      task.status = 'pending';
      this.addAudit('断点续算', `${this.keyOf(task.flagId)} 从 ${task.processed}/${task.total} 继续`);
      this.persist();
      this.pumpTasks();
    },
    simulateHit(user: SimUser): SimResult {
      if (!this.active) return { hit: false, reason: '未选择开关', chain: [] };
      return simulate(this.flags, this.active.id, user);
    }
  }
});
