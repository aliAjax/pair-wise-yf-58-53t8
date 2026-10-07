<script setup lang="ts">
import { computed, reactive, ref, watch, onMounted, onUnmounted } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { message } from 'ant-design-vue';
import { useFlagStore, SAMPLE_USERS, type SaveResult, type SimulationResult, type RecomputeTask } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const createOpen = ref(false);

/* 值班员身份（演示两人并发） */
const actor = ref('值班员甲');
const peer = computed(() => (actor.value === '值班员甲' ? '值班员乙' : '值班员甲'));

/* 命中模拟 */
const simulation = ref<SimulationResult | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });

/* 新建开关 */
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft', dependencies: [], rev: 1, updatedAt: '', updatedBy: actor.value });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [], version: 1, state: 'effective', rev: 1 });
  store.select(id); store.recordAudit('创建开关', `${values.key} 草稿版本 1`, actor.value); createOpen.value = false; resetForm();
});

/* ----------------------- 编辑会话（乐观锁基于 rev） ----------------------- */
const depsDraft = ref<string[]>([]);
const depsRev = ref(0);
const depsResult = ref<SaveResult | null>(null);
const rolloutDraft = ref(0);
const rolloutRev = ref(0);
const rolloutResult = ref<SaveResult | null>(null);

function syncDraftsFromServer() {
  if (!active.value) return;
  depsDraft.value = [...active.value.dependencies];
  depsRev.value = active.value.rev;
  depsResult.value = null;
  rolloutDraft.value = active.value.rollout;
  rolloutRev.value = active.value.rev;
  rolloutResult.value = null;
}

watch(() => store.activeId, syncDraftsFromServer, { immediate: true });

const depOptions = computed(() => store.flags
  .filter((f) => f.id !== store.activeId)
  .map((f) => ({ value: f.id, label: `${f.name}（${f.key}）`, disabled: !f.enabled })));

function submitDependencies() {
  if (!active.value) return;
  const result = store.saveDependencies(active.value.id, depsDraft.value, depsRev.value, actor.value);
  depsResult.value = result;
  if (result.ok) {
    message.success('依赖关系已保存，下游计划已联动处理');
    depsRev.value = store.flagById(active.value.id)!.rev;
  }
}
function submitRollout() {
  if (!active.value) return;
  const result = store.saveRollout(active.value.id, rolloutDraft.value, rolloutRev.value, actor.value);
  rolloutResult.value = result;
  if (result.ok) {
    message.success('放量比例已提交');
    rolloutRev.value = store.flagById(active.value.id)!.rev;
  }
}
/** 演示并发：让另一名值班员带着更新的 rev 抢先提交；本页编辑会话故意保留旧 rev */
function peerCommits(field: 'dependencies' | 'rollout') {
  if (!active.value) return;
  const f = store.flagById(active.value.id)!;
  if (field === 'rollout') {
    const peerValue = rolloutDraft.value >= 50 ? 25 : 75;
    store.saveRollout(f.id, peerValue, f.rev, peer.value);
    message.warning(`${peer.value} 已抢先把放量改为 ${peerValue}%，你的待提交修改仍保留`);
  } else {
    const candidates = store.flags.filter((item) => item.id !== f.id && !depsDraft.value.includes(item.id)).map((item) => item.id);
    if (!candidates.length) { message.info('没有可用于演示的其它开关'); return; }
    store.saveDependencies(f.id, [...depsDraft.value, candidates[0]], f.rev, peer.value);
    message.warning(`${peer.value} 已抢先提交依赖修改，你的待提交修改仍保留`);
  }
}

/* ------------------------------ 跨标签页同步 ------------------------------ */
const syncNotice = ref<string | null>(null);
function onStorage(event: StorageEvent) {
  if (event.key !== 'yf58-flag-state-v2') return;
  store.reloadFromStorage();
  syncNotice.value = `检测到另一个标签页（${peer.value}等）已写入：服务端版本已更新，你尚未提交的修改原样保留，提交时会给出冲突提示。`;
}
onMounted(() => { window.addEventListener('storage', onStorage); store.bootResume(); });
onUnmounted(() => window.removeEventListener('storage', onStorage));

/* -------------------------------- 其它 UI -------------------------------- */
function simulate() { if (active.value) { simulation.value = store.simulateHit(active.value.id, user); } }
function statusColor(status?: string) {
  switch (status) {
    case 'rolling': return 'green';
    case 'approved': return 'blue';
    case 'stopped':
    case 'rolled-back':
    case 'invalidated': return 'red';
    default: return 'gold';
  }
}
function statusLabel(status?: string) {
  return { draft: '草稿', approved: '已审批', rolling: '放量中', scheduled: '待定时', stopped: '已停止', 'rolled-back': '已回滚', invalidated: '已失效' }[status ?? 'draft'] ?? status;
}
const flagKey = (id: string) => store.flagById(id)?.key ?? id;
const taskProgress = (t: RecomputeTask) => Math.round((t.items.filter((i) => i.done).length / t.items.length) * 100);
const evaluationList = computed(() => store.flags.map((f) => store.evaluations[f.id]).filter(Boolean));
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar">
      <div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div>
      <a-space wrap>
        <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
        <span class="actor-box">值班员身份
          <a-select v-model:value="actor" size="small" style="width: 130px"
            :options="['值班员甲', '值班员乙'].map((value) => ({ value, label: value }))" />
        </span>
        <a-button type="primary" @click="createOpen = true">新建功能开关</a-button>
      </a-space>
    </a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-alert v-if="syncNotice" class="mb" type="warning" show-icon closable message="对端已写入" :description="syncNotice" @close="syncNotice = null" />

      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small">
            <a-list :data-source="store.flags" bordered>
              <template #renderItem="{ item }">
                <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                  <a-list-item-meta>
                    <template #title>
                      <a-space :size="4" wrap><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ statusLabel(item.status) }}</a-tag>
                        <a-tag v-if="store.planByFlag(item.id)?.state === 'invalidated'" color="red">计划已失效</a-tag>
                      </a-space>
                    </template>
                    <template #description>
                      <code>{{ item.key }}</code> · {{ item.rollout }}% · {{ item.dependencies.length }} 个前置 · rev{{ item.rev }}
                    </template>
                  </a-list-item-meta>
                </a-list-item>
              </template>
            </a-list>
          </a-card>

          <a-card title="规则命中模拟" size="small" class="mt">
            <a-form layout="vertical">
              <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
              <a-row :gutter="8">
                <a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col>
              </a-row>
              <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
              <a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button>
            </a-form>
            <template v-if="simulation">
              <a-alert class="mt" :type="simulation.hit ? 'success' : 'error'" show-icon
                :message="simulation.hit ? '命中新功能' : '拒绝放行'" :description="simulation.reason" />
              <div class="mt chain-title">最终采用的依赖链（自上而下）</div>
              <a-steps direction="vertical" size="small" :current="simulation.chain.findIndex((n) => !n.passed)" class="mt">
                <a-step v-for="node in simulation.chain" :key="node.flagId"
                  :status="node.passed ? 'finish' : 'error'" :title="node.flagId === active?.id ? `${node.name}（目标开关）` : node.name"
                  :description="node.passed ? `${node.key}：通过` : `${node.key}：${node.reason}`" />
              </a-steps>
            </template>
          </a-card>
        </a-col>

        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-alert class="mb" show-icon
              :type="plan.state === 'invalidated' ? 'error' : 'success'"
              :message="plan.state === 'invalidated' ? `发布计划已失效（v${plan.version}）` : `发布计划已生效（v${plan.version}）`"
              :description="plan.state === 'invalidated'
                ? `失效原因：${plan.invalidReason}。旧审批已清空，需两名负责人重新会签后方可再次发布。`
                : `审批：${plan.approvals.join('、') || '尚未会签'}`" />

            <a-card :title="active.name" class="mb">
              <template #extra>
                <a-space wrap>
                  <a-tag :color="statusColor(active.status)">{{ statusLabel(active.status) }}</a-tag>
                  <span class="rev-tag">rev{{ active.rev }} · {{ active.updatedBy || '系统' }} {{ active.updatedAt ? `· ${active.updatedAt}` : '' }}</span>
                  <a-switch checked-children="启用" un-checked-children="停用" :checked="active.enabled" @change="(checked: boolean) => active && store.setEnabled(active.id, checked, actor)" />
                  <a-button danger :disabled="!active.enabled" @click="store.emergencyStop(actor)">紧急停止</a-button>
                  <a-button danger ghost @click="store.rollback(actor)">回滚</a-button>
                </a-space>
              </template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                <a-descriptions-item label="当前放量">{{ active.rollout }}%</a-descriptions-item>
                <a-descriptions-item label="前置开关">{{ active.dependencies.length ? active.dependencies.map(flagKey).join('、') : '无' }}</a-descriptions-item>
              </a-descriptions>

              <a-divider>前置依赖（可挂多个前置开关）</a-divider>
              <a-space wrap align="start" class="dep-row">
                <a-select v-model:value="depsDraft" mode="multiple" allow-clear style="min-width: 320px; max-width: 460px"
                  placeholder="选择前置开关，全部命中时本开关才可能命中" :options="depOptions" />
                <a-space direction="vertical" :size="4">
                  <a-space>
                    <a-button type="primary" @click="submitDependencies">保存依赖（读取时 rev{{ depsRev }}）</a-button>
                    <a-button @click="peerCommits('dependencies')">模拟{{ peer }}抢先改依赖</a-button>
                  </a-space>
                  <span class="hint">停用中的前置开关不可选；保存时会做环路检测。</span>
                </a-space>
              </a-space>
              <a-alert v-if="depsResult?.cycle" class="mt" type="error" show-icon
                message="依赖存在环路，已阻止保存"
                :description="`环路涉及开关：${depsResult.cycle.cycleLabels.join(' → ')}（回到 ${depsResult.cycle.cycleLabels[0]}）。请移除其中一条依赖后重试。`" />
              <a-alert v-else-if="depsResult?.conflict" class="mt" type="error" show-icon
                message="依赖保存冲突：另一名值班员已先行提交"
                :description="`你基于 rev${depsResult.conflict.expectedRev} 编辑，服务端已是 rev${depsResult.conflict.serverRev}，当前依赖为 [${(depsResult.conflict.serverValue as string[]).map(flagKey).join('、') || '无'}]。先前提交的结果已保留，你的选择未被覆盖。`">
                <template #action><a-button size="small" @click="syncDraftsFromServer">放弃本地修改并拉取最新</a-button></template>
              </a-alert>
              <a-alert v-else-if="depsResult && !depsResult.ok" class="mt" type="error" show-icon :message="depsResult.error" />

              <a-divider>逐步放量（乐观锁提交）</a-divider>
              <a-slider v-model:value="rolloutDraft" :min="0" :max="100" :step="5" style="max-width: 520px" />
              <a-space wrap>
                <span class="rollout-label">待提交：{{ rolloutDraft }}%</span>
                <a-button type="primary" @click="submitRollout">提交放量（读取时 rev{{ rolloutRev }}）</a-button>
                <a-button @click="peerCommits('rollout')">模拟{{ peer }}抢先改放量</a-button>
              </a-space>
              <a-alert v-if="rolloutResult?.conflict" class="mt" type="error" show-icon
                message="放量提交冲突：另一名值班员已先行提交"
                :description="`你基于 rev${rolloutResult.conflict.expectedRev} 编辑，服务端已是 rev${rolloutResult.conflict.serverRev}，放量现为 ${rolloutResult.conflict.serverValue}%。先前结果保留，你的滑块值仍为 ${rolloutDraft}%，未被覆盖。`">
                <template #action><a-button size="small" @click="syncDraftsFromServer">放弃本地修改并拉取最新</a-button></template>
              </a-alert>

              <a-divider>规则组合</a-divider>
              <a-form layout="vertical">
                <a-row :gutter="16">
                  <a-col :span="8"><a-form-item label="目标地区"><a-select :value="active.rules.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" @change="(value: string) => store.updateRule({ region: value }, actor)" /></a-form-item></a-col>
                  <a-col :span="8"><a-form-item label="客户端版本"><a-input :value="active.rules.appVersion" @change="(event: Event) => store.updateRule({ appVersion: (event.target as HTMLInputElement).value }, actor)" /></a-form-item></a-col>
                  <a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="active.rules.authenticated" @change="(checked: boolean) => store.updateRule({ authenticated: checked }, actor)" /></a-form-item></a-col>
                </a-row>
              </a-form>

              <a-divider>定时生效</a-divider>
              <a-space wrap>
                <a-input type="datetime-local" :value="plan.scheduledAt" @change="(event: Event) => store.schedule((event.target as HTMLInputElement).value, actor)" />
                <a-button @click="store.schedule(plan.scheduledAt, actor)">保存定时</a-button>
              </a-space>

              <a-divider>审批与发布</a-divider>
              <a-space wrap>
                <a-button :disabled="plan.approvals.includes('产品负责人') && plan.state === 'effective'" @click="store.approve('产品负责人', actor)">产品审批</a-button>
                <a-button :disabled="plan.approvals.includes('研发负责人') && plan.state === 'effective'" @click="store.approve('研发负责人', actor)">研发审批</a-button>
                <a-button type="primary" :disabled="active.status !== 'approved' || plan.state !== 'effective' || plan.approvals.length < 2" @click="store.startRollout(actor)">开始灰度发布</a-button>
              </a-space>
            </a-card>

            <a-card title="命中范围重算任务（支持断点续算）" size="small" class="mb">
              <a-empty v-if="!store.tasks.length" description="上游暂无改动，没有重算任务" />
              <a-timeline>
                <a-timeline-item v-for="t in store.tasks" :key="t.id"
                  :color="t.status === 'done' ? 'green' : t.status === 'failed' ? 'red' : 'blue'">
                  <a-space wrap>
                    <b>{{ t.reason }}</b>
                    <a-tag :color="t.status === 'done' ? 'green' : t.status === 'failed' ? 'red' : 'processing'">
                      {{ t.status === 'done' ? '已完成' : t.status === 'failed' ? (t.interrupted ? '刷新中断' : '写入失败') : '重算中' }}
                    </a-tag>
                    <span class="hint">触发人：{{ t.triggeredBy }} · {{ t.createdAt }}</span>
                  </a-space>
                  <a-progress :percent="taskProgress(t)" size="small" :status="t.status === 'failed' ? 'exception' : t.status === 'done' ? 'success' : 'active'" class="mt" />
                  <div class="hint mt">断点：{{ t.items.filter((i) => i.done).length }}/{{ t.items.length }}
                    （<span v-for="(item, idx) in t.items" :key="item.flagId">
                      <a-tag :color="item.done ? 'green' : 'default'" class="mini-tag">{{ flagKey(item.flagId) }}{{ item.done ? '✓' : idx === t.cursor && t.status !== 'done' ? '◀断点' : '' }}</a-tag>
                    </span>）
                  </div>
                  <a-alert v-if="t.status === 'failed'" class="mt" type="error" show-icon :message="t.lastError">
                    <template #action><a-button size="small" type="primary" @click="store.resumeTask(t.id)">从断点继续重试</a-button></template>
                  </a-alert>
                  <a-button v-else-if="t.status === 'running'" size="small" class="mt" ghost danger @click="store.armWriteFailure(t.id)">演练：让下一次检查点写入失败</a-button>
                  <div v-else class="hint mt">完成于 {{ t.finishedAt }}</div>
                </a-timeline-item>
              </a-timeline>
            </a-card>

            <a-card title="命中范围结果（已生效 / 已失效）" size="small" class="mb">
              <a-table :data-source="evaluationList" :pagination="false" row-key="flagId" size="small">
                <a-table-column key="flagId" title="开关">
                  <template #default="{ record }"><b>{{ store.flagById(record.flagId)?.name }}</b><br /><code>{{ flagKey(record.flagId) }}</code></template>
                </a-table-column>
                <a-table-column key="result" title="结果状态" :width="110">
                  <template #default="{ record }">
                    <a-tag :color="record.result === 'effective' ? 'green' : 'red'">{{ record.result === 'effective' ? '已生效' : '已失效' }}</a-tag>
                  </template>
                </a-table-column>
                <a-table-column key="hit" title="命中范围" :width="120">
                  <template #default="{ record }">{{ record.result === 'effective' ? `${record.hitCount}/${record.total} 用户` : '—' }}</template>
                </a-table-column>
                <a-table-column key="chain" title="最终依赖链">
                  <template #default="{ record }">
                    <a-space :size="2" wrap>
                      <template v-for="(id, idx) in record.chain" :key="id">
                        <a-tag :color="record.result === 'effective' ? 'green' : 'red'">{{ flagKey(id) }}</a-tag>
                        <span v-if="idx < record.chain.length - 1">→</span>
                      </template>
                      <span v-if="!record.chain.length" class="hint">无</span>
                    </a-space>
                  </template>
                </a-table-column>
                <a-table-column key="reject" title="拒绝/失效原因">
                  <template #default="{ record }"><span v-if="record.rejectReason" class="reject-text">{{ record.rejectReason }}</span><span v-else class="hint">—</span></template>
                </a-table-column>
                <a-table-column key="time" title="计算时间" :width="170">
                  <template #default="{ record }"><span class="hint">{{ record.computedAt }}</span></template>
                </a-table-column>
              </a-table>
              <div class="hint mt">样本用户 {{ SAMPLE_USERS.length }} 名（{{ SAMPLE_USERS.map((u) => u.id).join('、') }}）。</div>
            </a-card>

            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('失效') || item.action.includes('冲突') ? 'red' : 'blue'"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
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
.actor-box { color: #e0e7ff; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }
.selected { background: #eef2ff; cursor: pointer; }
.rollout-label { color: #4338ca; font-weight: 700; }
.rev-tag { color: #6b7280; font-size: 12px; }
.hint { color: #6b7280; font-size: 12px; }
.dep-row { row-gap: 10px; }
.chain-title { font-size: 13px; font-weight: 600; color: #374151; }
.mini-tag { margin: 2px; font-size: 11px; }
.reject-text { color: #b91c1c; font-size: 12px; }
.ant-list-item { cursor: pointer; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
