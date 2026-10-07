<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore, type RolloutPlan, type SimResult } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const createOpen = ref(false);
const simulation = ref<SimResult | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft', dependsOn: [], version: 1 });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [], version: 1, state: 'draft' });
  store.select(id); store.addAudit('创建开关', `${values.key} 草稿版本 1`); createOpen.value = false; resetForm();
});
function simulate() { if (active.value) simulation.value = store.simulateHit(user); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }

// 依赖编辑草稿与版本基线
const depDraft = ref<string[]>([]);
const baseVersion = ref(1);
const cycleError = ref('');
const conflictError = ref('');
const storageConflict = ref(false);

watch(active, (flag) => {
  depDraft.value = [...(flag?.dependsOn ?? [])];
  baseVersion.value = flag?.version ?? 1;
  cycleError.value = '';
  conflictError.value = '';
  storageConflict.value = false;
  simulation.value = null;
}, { immediate: true });

const depOptions = computed(() => store.flags
  .filter((flag) => flag.id !== store.activeId && !depDraft.value.includes(flag.id))
  .map((flag) => ({ value: flag.id, label: `${flag.name}（${flag.key}）` })));

function keyOf(flagId: string) { return store.flags.find((flag) => flag.id === flagId)?.key ?? flagId; }
function planOf(flagId: string) { return store.plans.find((item) => item.flagId === flagId); }

function saveDeps() {
  if (!active.value) return;
  cycleError.value = '';
  conflictError.value = '';
  try {
    store.setDependencies(active.value.id, depDraft.value, baseVersion.value);
    message.success('依赖关系已保存，受影响子开关计划已失效并重算命中范围');
  } catch (err) {
    const e = err as { code?: string; cycle?: string[]; message?: string };
    if (e.code === 'CYCLE') cycleError.value = `无法保存：检测到环路 ${(e.cycle ?? []).join(' → ')}`;
    else if (e.code === 'CONFLICT') conflictError.value = `提交失败：${e.message ?? '版本冲突'}，您的修改未写入，先前结果已保留。请刷新为最新版本后重试。`;
    else message.error('保存失败');
  }
}

function changeRollout(value: number) {
  if (!active.value) return;
  try {
    store.setRollout(value, baseVersion.value);
    message.success('放量已更新，相关计划已失效并重新计算命中范围');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'CONFLICT') {
      conflictError.value = `提交失败：${e.message ?? '版本冲突'}，放量修改未写入，先前结果已保留。`;
      message.error('提交冲突，放量未写入');
    }
  }
}

function simulateOtherOperator() {
  if (!active.value) return;
  store.bumpVersion(active.value.id);
  conflictError.value = '';
  message.warning('已模拟另一值班员提交修改，开关版本已变化');
}

function reloadLatest() {
  store.reloadFromStorage();
  storageConflict.value = false;
  conflictError.value = '';
  message.success('已刷新为最新版本');
}

onMounted(() => {
  store.resumeTasks();
  window.addEventListener('storage', (event) => {
    if (event.key !== 'yf58-flag-state' || !event.newValue) return;
    try {
      const next = JSON.parse(event.newValue) as { flags?: Array<{ id: string; version: number }> };
      const nextFlag = next.flags?.find((flag) => flag.id === store.activeId);
      const current = store.flags.find((flag) => flag.id === store.activeId);
      if (nextFlag && current && nextFlag.version !== current.version) storageConflict.value = true;
    } catch { /* 忽略损坏的写入 */ }
  });
});

const activeTasks = computed(() => store.recalcTasks.filter((task) => task.flagId === store.activeId));
const invalidCount = computed(() => store.plans.filter((item) => item.state === 'invalid').length);

function planTag(item?: RolloutPlan) {
  if (!item) return { color: 'default', text: '无计划' };
  if (item.state === 'effective') return { color: 'green', text: '生效中' };
  if (item.state === 'invalid') return { color: 'red', text: '已失效' };
  return { color: 'default', text: '草稿' };
}
function taskStatusText(status: string) {
  return ({ pending: '等待中', running: '重算中', failed: '写入失败', done: '已完成' } as Record<string, string>)[status] ?? status;
}
function taskPercent(processed: number, total: number) { return total ? Math.round((processed / total) * 100) : 0; }
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-tag v-if="invalidCount" color="red">{{ invalidCount }} 个计划已失效</a-tag><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small"><a-list :data-source="store.flags" bordered><template #renderItem="{ item }"><a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)"><a-list-item-meta><template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag><a-tag v-if="planOf(item.id)?.state === 'invalid'" color="red">计划失效</a-tag></a-space></template><template #description><code>{{ item.key }}</code> · {{ item.rollout }}%<div class="dep-tags"><a-tag v-for="dep in (item.dependsOn || [])" :key="dep" color="blue" class="dep-tag">依赖 {{ keyOf(dep) }}</a-tag></div></template></a-list-item-meta></a-list-item></template></a-list></a-card>
          <a-card title="规则命中模拟" size="small" class="mt"><a-form layout="vertical"><a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item><a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row><a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox><a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button></a-form><a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'warning'" show-icon :message="simulation.hit ? '命中新功能' : '未命中'" :description="simulation.reason" /><template v-if="simulation"><a-divider>依赖链评估</a-divider><div v-for="(node, index) in simulation.chain" :key="node.id" class="chain-node"><a-tag color="blue">{{ index + 1 }}</a-tag><code>{{ node.key }}</code><span class="chain-name">{{ node.name }}</span><a-tag v-if="node.passed" color="green">通过</a-tag><a-tag v-else-if="node.reason === '前置未通过，未评估'" color="default">未评估</a-tag><a-tag v-else color="red">拒绝：{{ node.reason }}</a-tag></div></template></a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb"><template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button><a-button danger ghost @click="store.rollback">回滚</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }"><a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item><a-descriptions-item label="当前放量">{{ active.rollout }}%</a-descriptions-item><a-descriptions-item label="审批">{{ plan.approvals.join('、') || '待审批' }}</a-descriptions-item><a-descriptions-item label="计划状态"><a-tag :color="planTag(plan)?.color">{{ planTag(plan)?.text }}</a-tag><span v-if="plan.state === 'effective' && plan.effectiveAt" class="effective-at">已于 {{ plan.effectiveAt }} 生效</span></a-descriptions-item><a-descriptions-item label="版本">v{{ active.version }}</a-descriptions-item></a-descriptions>
              <a-divider>规则组合</a-divider><a-form layout="vertical"><a-row :gutter="16"><a-col :span="8"><a-form-item label="目标地区"><a-select :value="active.rules.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" @change="(value: string) => store.updateRule({ region: value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="客户端版本"><a-input :value="active.rules.appVersion" @change="(event: Event) => store.updateRule({ appVersion: (event.target as HTMLInputElement).value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="active.rules.authenticated" @change="(checked: boolean) => store.updateRule({ authenticated: checked })" /></a-form-item></a-col></a-row></a-form>
              <a-divider>依赖关系（前置开关）</a-divider>
              <a-alert v-if="storageConflict" class="mb" type="error" show-icon message="检测到其他值班员已在另一窗口修改此开关" description="您当前看到的是旧版本，直接提交会被拒绝，请先刷新为最新版本。"><template #action><a-button size="small" @click="reloadLatest">刷新为最新版本</a-button></template></a-alert>
              <a-select v-model:value="depDraft" mode="multiple" :options="depOptions" placeholder="选择前置开关（可多选，形成引用时会拦截环路）" />
              <a-space class="mt" wrap><a-button type="primary" @click="saveDeps">保存依赖</a-button><a-button @click="simulateOtherOperator">模拟另一值班员提交</a-button><span class="version-tag">当前版本 v{{ active.version }}</span></a-space>
              <a-alert v-if="cycleError" class="mt" type="error" show-icon :message="cycleError" description="请移除成环的依赖后重新保存。" />
              <a-alert v-if="conflictError" class="mt" type="error" show-icon message="提交冲突" :description="conflictError" />
              <a-divider>逐步放量</a-divider><a-slider :value="active.rollout" :min="0" :max="100" :step="5" @change="(value: number) => changeRollout(value)" /><div class="rollout-label">{{ active.rollout }}% 用户可命中</div>
              <a-divider>定时生效</a-divider><a-space><a-input type="datetime-local" :value="plan.scheduledAt" @change="(event: Event) => store.schedule((event.target as HTMLInputElement).value)" /><a-button @click="store.schedule(plan.scheduledAt)">保存定时</a-button></a-space>
              <a-alert v-if="plan.state === 'invalid'" class="mt" type="error" show-icon message="发布计划已失效" :description="`${plan.invalidReason ?? ''}（${plan.invalidatedAt ?? ''}）。失效期间命中范围不再按原计划执行，重算完成后自动恢复生效。`" />
              <a-card v-if="activeTasks.length" size="small" class="mt" title="命中范围重算任务（断点续算）"><div v-for="task in activeTasks" :key="task.id" class="task-row"><a-tag :color="task.status === 'done' ? 'green' : task.status === 'failed' ? 'red' : 'blue'">{{ taskStatusText(task.status) }}</a-tag><div class="task-body"><div>{{ task.reason }} · 断点 {{ task.processed }}/{{ task.total }}<template v-if="task.status === 'done'"> · 命中 {{ task.hitCount }} 个用户（{{ Math.round(task.hitCount / task.total * 100) }}%）</template></div><a-progress :percent="taskPercent(task.processed, task.total)" size="small" /></div><a-button v-if="task.status === 'failed'" size="small" type="primary" @click="store.retryTask(task.id)">继续重试</a-button></div></a-card>
              <a-divider>审批与发布</a-divider><a-space><a-button :disabled="plan.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button><a-button :disabled="plan.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button><a-button type="primary" :disabled="active.status !== 'approved'" @click="store.startRollout">开始灰度发布</a-button></a-space>
            </a-card>
            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('失败') ? 'red' : 'blue'"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create"><a-form layout="vertical"><a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item><a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item></a-form></a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.ant-list-item { cursor: pointer; }
.dep-tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
.dep-tag { margin-inline-start: 0; }
.chain-node { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.chain-name { color: #4b5563; }
.version-tag { color: #6b7280; font-size: 12px; }
.effective-at { color: #16a34a; font-size: 12px; margin-left: 8px; }
.task-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.task-body { flex: 1; min-width: 0; }
.task-progress { margin-top: 2px; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
