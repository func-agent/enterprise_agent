import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from 'pg';
import {
  PgMetadataStore,
  SqliteMetadataStore,
  WORKFLOW_LIST_LIMIT_MAX,
  formatWorkflowCursor,
  parseStringArray,
  resolveWorkflowListLimit,
  type MetadataStore,
  type WorkflowRecord,
  type WorkflowRunRecord,
  type WorkflowStepRunRecord,
  type WorkflowTemplateRecord,
  type WorkflowTemplateVersionRecord,
  type WorkflowVersionRecord,
  type WorkflowVisibility,
} from '../packages/platform-core/src/index.js';

const T0 = '2026-11-27T00:00:00.000Z';
const T1 = '2026-11-27T00:00:01.000Z';
const T2 = '2026-11-27T00:00:02.000Z';
const T3 = '2026-11-27T00:00:03.000Z';

function workflow(id: string, tenantId: string, ownerId = 'owner-1'): WorkflowRecord {
  return {
    id,
    tenantId,
    ownerId,
    name: '制度审查',
    description: '工作流存储契约',
    visibility: 'private',
    currentDraftVersion: 1,
    createdAt: T0,
    updatedAt: T0,
  };
}

function version(workflowId: string, tenantId: string, value = 1): WorkflowVersionRecord {
  return {
    workflowId,
    version: value,
    tenantId,
    definition: { schemaVersion: 1, name: '制度审查', nodes: [], edges: [] },
    checksum: `checksum-${value}`,
    status: 'draft',
    createdBy: 'owner-1',
    createdAt: T0,
  };
}

function run(id: string, record: WorkflowRecord, mode: 'debug' | 'published' = 'debug'): WorkflowRunRecord {
  return {
    id,
    tenantId: record.tenantId,
    workflowId: record.id,
    workflowVersion: 1,
    initiatorId: 'owner-1',
    identitySnapshot: { sub: 'owner-1', tenantId: record.tenantId, role: 'employee' },
    input: { question: '审查制度' },
    mode,
    status: 'queued',
    definitionSnapshot: mode === 'debug' ? { schemaVersion: 1, nodes: [], edges: [] } : undefined,
    definitionChecksum: 'checksum-1',
    traceId: `trace-${id}`,
    lockVersion: 0,
    createdAt: T0,
    updatedAt: T0,
    expiresAt: '2026-12-27T00:00:00.000Z',
  };
}

function template(id: string, scope: 'platform' | 'tenant', tenantId?: string): WorkflowTemplateRecord {
  return {
    id,
    scope,
    tenantId,
    name: `${scope}-template`,
    status: 'draft',
    currentDraftVersion: 1,
    createdBy: 'admin-1',
    createdAt: T0,
    updatedAt: T0,
  };
}

function templateVersion(templateId: string): WorkflowTemplateVersionRecord {
  return {
    templateId,
    version: 1,
    definition: { schemaVersion: 1, nodes: [], edges: [] },
    resourceSlots: [{ type: 'modelSlot', name: 'model' }],
    checksum: 'template-checksum-1',
    status: 'draft',
    createdBy: 'admin-1',
    createdAt: T0,
  };
}

async function seed(store: MetadataStore, tenantId: string): Promise<{ workflow: WorkflowRecord; version: WorkflowVersionRecord }> {
  const id = `wf-${randomUUID()}`;
  const workflowRecord = workflow(id, tenantId);
  expect(await store.upsertWorkflow(workflowRecord)).toBe(true);
  const versionRecord = version(id, tenantId);
  // 已发布版本必须走「草稿 → 提交审核 → 发布」三步：
  // 普通 upsert 只能写草稿态，直接写 published 等于绕过审核通道（见 9.2）。
  expect(await store.upsertWorkflowVersion(versionRecord)).toBe(true);
  expect(await store.submitWorkflowVersionForReview(tenantId, id, versionRecord.version)).toBe(true);
  expect(await store.publishWorkflowVersion(tenantId, id, versionRecord.version, {
    reviewer: 'admin-1',
    at: T1,
  })).toBe(true);
  return { workflow: workflowRecord, version: versionRecord };
}

interface Backend {
  name: string;
  available: boolean;
  /** 可以是异步的：PostgreSQL 需要先清理工作流表再交给 store。 */
  create: () => MetadataStore | Promise<MetadataStore>;
}

/** 清空工作流相关的表，让每个用例都从干净状态开始（对齐 SQLite 的 :memory:）。 */
async function dropWorkflowTables(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'DROP TABLE IF EXISTS workflow_step_runs, workflow_runs, workflow_versions, '
      + 'workflow_template_versions, workflow_templates, workflows CASCADE',
    );
  } finally {
    await client.end();
  }
}

function registerContract(backend: Backend): void {
  const suite = backend.available ? describe : describe.skip;
  suite(`${backend.name} 工作流存储契约`, () => {
    let store: MetadataStore;

    beforeEach(async () => {
      store = await backend.create();
      await store.init();
    });

    afterEach(async () => {
      await store.close();
    });

    it('工作流租户隔离、软删除与已发布版本不可变', async () => {
      const tenantA = `tenant-a-${randomUUID()}`;
      const tenantB = `tenant-b-${randomUUID()}`;
      const record = workflow(`wf-${randomUUID()}`, tenantA);
      expect(await store.upsertWorkflow(record)).toBe(true);
      expect((await store.getWorkflow(tenantA, record.id))?.name).toBe('制度审查');
      expect(await store.getWorkflow(tenantB, record.id)).toBeUndefined();
      expect(await store.upsertWorkflow({ ...record, tenantId: tenantB, name: '越权覆盖' })).toBe(false);
      expect((await store.getWorkflow(tenantA, record.id))?.name).toBe('制度审查');
      expect(await store.listWorkflows({ tenantId: tenantA, ownerId: 'someone-else' })).toEqual([]);

      const draft = version(record.id, tenantA);
      expect(await store.upsertWorkflowVersion(draft)).toBe(true);
      // 普通 upsert 不能把草稿直接改成审核中或已发布：必须走显式通道。
      expect(await store.upsertWorkflowVersion({ ...draft, status: 'in_review' })).toBe(false);
      expect(await store.upsertWorkflowVersion({ ...draft, status: 'published' })).toBe(false);
      expect((await store.getWorkflowVersion(tenantA, record.id, 1))?.status).toBe('draft');
      // 提交审核：显式通道，且不写审核与发布字段。
      expect(await store.submitWorkflowVersionForReview(tenantA, record.id, 1)).toBe(true);
      expect((await store.getWorkflowVersion(tenantA, record.id, 1))?.status).toBe('in_review');
      expect((await store.getWorkflowVersion(tenantA, record.id, 1))?.reviewedBy).toBeUndefined();
      const published: WorkflowVersionRecord = {
        ...draft,
        definition: { schemaVersion: 1, name: '已发布', nodes: [], edges: [] },
        checksum: 'checksum-published',
        status: 'published',
        reviewedBy: 'admin-1',
        reviewedAt: T1,
        publishedBy: 'admin-1',
        publishedAt: T2,
      };
      // 新契约：审核中的版本被锁定，普通 upsert 不得改写它（见 9.2 / 10.1 R9）。
      expect(await store.upsertWorkflowVersion(published)).toBe(false);
      expect((await store.getWorkflowVersion(tenantA, record.id, 1))?.status).toBe('in_review');
      // 驳回后重新开放草稿，审核人才能完成发布。
      expect(await store.rejectWorkflowVersion(tenantA, record.id, 1, {
        reviewer: 'admin-1',
        comment: '缺少人工审核节点',
        at: T1,
      })).toBe(true);
      expect(await store.upsertWorkflowVersion({ ...draft, status: 'draft', checksum: 'checksum-fixed' })).toBe(true);
      // 已发布只能走显式发布通道：普通 upsert 写不进 published。
      expect(await store.upsertWorkflowVersion(published)).toBe(false);
      expect(await store.publishWorkflowVersion(tenantA, record.id, 1, { reviewer: 'admin-1', at: T2 })).toBe(true);
      expect(await store.upsertWorkflowVersion({ ...draft, checksum: 'tampered' })).toBe(false);
      expect((await store.getWorkflowVersion(tenantA, record.id, 1))?.checksum).toBe('checksum-fixed');
      expect((await store.getWorkflowVersion(tenantA, record.id, 1))?.publishedBy).toBe('admin-1');
      expect(await store.getWorkflowVersion(tenantB, record.id, 1)).toBeUndefined();
      expect(await store.upsertWorkflowVersion(version(record.id, tenantA, 2))).toBe(true);

      expect(await store.deleteWorkflow(tenantB, record.id, T3)).toBe(false);
      expect(await store.deleteWorkflow(tenantA, record.id, T3)).toBe(true);
      expect(await store.listWorkflows({ tenantId: tenantA })).toEqual([]);
      // private 工作流只有所有者可见，因此这里必须带上所有者身份（见 3.2）。
      expect(await store.listWorkflows({ tenantId: tenantA, ownerId: 'owner-1', includeDeleted: true })).toHaveLength(1);
      expect(await store.getWorkflowVersion(tenantA, record.id, 1)).toBeDefined();
      expect(await store.listWorkflowVersions(tenantA, record.id)).toHaveLength(2);
      expect(await store.upsertWorkflowVersion(version(record.id, tenantA, 3))).toBe(false);
    });

    it('运行幂等、快照 CHECK、过滤与乐观锁并发转换', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const first = run(`run-${randomUUID()}`, seeded.workflow);
      first.idempotencyKey = 'client-key-1';
      expect(await store.insertWorkflowRun(first)).toBe(true);
      expect(await store.insertWorkflowRun({
        ...first,
        id: `run-${randomUUID()}`,
        traceId: 'another-trace',
      })).toBe(false);
      expect((await store.getWorkflowRunByIdempotencyKey(tenantId, seeded.workflow.id, 'owner-1', 'client-key-1'))?.id).toBe(first.id);
      expect((await store.getWorkflowRun(tenantId, first.id))?.definitionSnapshot).toEqual(first.definitionSnapshot);

      const publishedRun = run(`run-${randomUUID()}`, seeded.workflow, 'published');
      const secondPublishedRun = run(`run-${randomUUID()}`, seeded.workflow, 'published');
      expect(await store.insertWorkflowRun(publishedRun)).toBe(true);
      expect(await store.insertWorkflowRun(secondPublishedRun)).toBe(true);
      expect((await store.getWorkflowRun(tenantId, publishedRun.id))?.definitionSnapshot).toBeUndefined();
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow, 'published'),
        definitionSnapshot: { unexpected: true },
      })).rejects.toThrow();
      expect(await store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow),
        tenantId: `other-${randomUUID()}`,
      })).toBe(false);

      const running = await store.transitionWorkflowRun(tenantId, first.id, 'queued', 0, {
        status: 'running', startedAt: T1, updatedAt: T1,
      });
      expect(running?.lockVersion).toBe(1);
      expect(running?.startedAt).toBe(T1);
      expect(await store.transitionWorkflowRun(tenantId, first.id, 'queued', 0, {
        status: 'running', updatedAt: T2,
      })).toBeUndefined();
      expect(await store.transitionWorkflowRun(`other-${tenantId}`, first.id, 'running', 1, {
        status: 'failed', updatedAt: T2,
      })).toBeUndefined();
      const succeeded = await store.transitionWorkflowRun(tenantId, first.id, 'running', 1, {
        status: 'succeeded', endedAt: T2, updatedAt: T2,
      });
      expect(succeeded?.lockVersion).toBe(2);
      expect(succeeded?.endedAt).toBe(T2);

      const concurrent = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(concurrent)).toBe(true);
      const transitions = await Promise.all([
        store.transitionWorkflowRun(tenantId, concurrent.id, 'queued', 0, { status: 'running', updatedAt: T1 }),
        store.transitionWorkflowRun(tenantId, concurrent.id, 'queued', 0, { status: 'running', updatedAt: T1 }),
      ]);
      expect(transitions.filter((item) => item !== undefined)).toHaveLength(1);
      expect((await store.getWorkflowRun(tenantId, concurrent.id))?.lockVersion).toBe(1);
      expect(await store.listWorkflowRuns({ tenantId, status: 'succeeded' })).toHaveLength(1);
      expect(await store.listWorkflowRuns({ tenantId, initiatorId: 'nobody' })).toEqual([]);
    });

    it('步骤按运行租户隔离且同节点更新不产生重复记录', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const runRecord = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(runRecord)).toBe(true);
      const step: WorkflowStepRunRecord = {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'retrieve',
        attempt: 1,
        status: 'running',
        input: { query: '制度' },
        sideEffectUnknown: false,
        startedAt: T1,
        createdAt: T0,
        updatedAt: T1,
      };
      expect(await store.upsertWorkflowStepRun(tenantId, step)).toBe(true);
      expect(await store.getWorkflowStepRun(`other-${tenantId}`, runRecord.id, 'retrieve')).toBeUndefined();
      expect(await store.listWorkflowStepRuns(`other-${tenantId}`, runRecord.id)).toEqual([]);
      expect(await store.upsertWorkflowStepRun(`other-${tenantId}`, step)).toBe(false);

      expect(await store.upsertWorkflowStepRun(tenantId, {
        ...step,
        id: `step-${randomUUID()}`,
        attempt: 2,
        status: 'succeeded',
        output: { text: '结果' },
        sideEffectUnknown: true,
        endedAt: T2,
        updatedAt: T2,
      })).toBe(true);
      const steps = await store.listWorkflowStepRuns(tenantId, runRecord.id);
      expect(steps).toHaveLength(1);
      expect(steps[0].attempt).toBe(2);
      expect(steps[0].output).toEqual({ text: '结果' });
      expect(steps[0].sideEffectUnknown).toBe(true);
      expect(await store.upsertWorkflowStepRun(tenantId, { ...step, runId: 'missing-run' })).toBe(false);
    });

    it('平台/租户模板可见性、作用域 CHECK 与版本不可变', async () => {
      const tenantA = `tenant-a-${randomUUID()}`;
      const tenantB = `tenant-b-${randomUUID()}`;
      const platform = template(`tpl-${randomUUID()}`, 'platform');
      const tenantTemplate = template(`tpl-${randomUUID()}`, 'tenant', tenantA);
      const otherTemplate = template(`tpl-${randomUUID()}`, 'tenant', tenantB);
      expect(await store.upsertPlatformWorkflowTemplate(platform)).toBe(true);
      expect(await store.upsertTenantWorkflowTemplate(tenantA, tenantTemplate)).toBe(true);
      expect(await store.upsertTenantWorkflowTemplate(tenantB, otherTemplate)).toBe(true);
      const visibleToA = (await store.listWorkflowTemplates(tenantA)).map((item) => item.id);
      // 平台模板与本租户模板可见；其他租户的模板不可见
      expect(visibleToA).toContain(platform.id);
      expect(visibleToA).toContain(tenantTemplate.id);
      expect(visibleToA).not.toContain(otherTemplate.id);
      expect(await store.getWorkflowTemplate(tenantB, tenantTemplate.id)).toBeUndefined();
      // 租户不能改写其他租户的模板
      expect(await store.upsertTenantWorkflowTemplate(tenantB, { ...tenantTemplate, tenantId: tenantB, name: 'stolen' })).toBe(false);
      expect((await store.getWorkflowTemplate(tenantA, tenantTemplate.id))?.name).toBe(tenantTemplate.name);

      // 平台模板不能绑定租户：违反作用域与租户归属互斥时给统一领域错误（两端一致）
      await expect(store.upsertPlatformWorkflowTemplate({
        ...template(`tpl-${randomUUID()}`, 'platform'),
        tenantId: tenantA,
      })).rejects.toThrow(TypeError);
      await expect(store.upsertPlatformWorkflowTemplate({
        ...template(`tpl-${randomUUID()}`, 'platform'),
        tenantId: tenantA,
      })).rejects.toThrow(/scope/);
      // 租户写入入口不能写平台作用域
      expect(await store.upsertTenantWorkflowTemplate(tenantA, template(`tpl-${randomUUID()}`, 'platform'))).toBe(false);
      // 租户入口以调用参数为归属：记录里没写 tenantId 时落到调用方租户
      const bound = template(`tpl-${randomUUID()}`, 'tenant');
      expect(await store.upsertTenantWorkflowTemplate(tenantA, bound)).toBe(true);
      expect((await store.getWorkflowTemplate(tenantA, bound.id))?.tenantId).toBe(tenantA);

      const tenantVersion = templateVersion(tenantTemplate.id);
      expect(await store.upsertTenantWorkflowTemplateVersion(tenantA, tenantVersion)).toBe(true);
      expect(await store.upsertTenantWorkflowTemplateVersion(tenantB, tenantVersion)).toBe(false);
      expect(await store.getWorkflowTemplateVersion(tenantB, tenantTemplate.id, 1)).toBeUndefined();
      expect(await store.upsertTenantWorkflowTemplateVersion(tenantA, {
        ...tenantVersion,
        status: 'published',
        publishedBy: 'admin-1',
        publishedAt: T1,
      })).toBe(true);
      expect(await store.upsertTenantWorkflowTemplateVersion(tenantA, { ...tenantVersion, checksum: 'tampered' })).toBe(false);
      expect((await store.getWorkflowTemplateVersion(tenantA, tenantTemplate.id, 1))?.checksum)
        .toBe('template-checksum-1');

      const platformVersion = templateVersion(platform.id);
      expect(await store.upsertPlatformWorkflowTemplateVersion(platformVersion)).toBe(true);
      expect((await store.getWorkflowTemplateVersion(tenantB, platform.id, 1))?.resourceSlots)
        .toEqual(platformVersion.resourceSlots);
      expect(await store.listWorkflowTemplateVersions(tenantB, tenantTemplate.id)).toEqual([]);
    });

    it('不确定副作用标志黏性，旧尝试与过期快照不覆盖新状态', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const runRecord = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(runRecord)).toBe(true);
      const step: WorkflowStepRunRecord = {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'notify',
        attempt: 2,
        status: 'failed',
        output: { text: '第二次结果' },
        errorCode: 'WRITE_UNKNOWN',
        approvalId: 'approval-2',
        idempotencyKey: 'attempt-2',
        sideEffectUnknown: true,
        llmCalls: 2,
        toolCalls: 3,
        createdAt: T0,
        updatedAt: T1,
      };
      expect(await store.upsertWorkflowStepRun(tenantId, step)).toBe(true);
      // 迟到的旧尝试可以写入，但只能保留安全标志，不能覆盖较新的完整状态快照。
      expect(await store.upsertWorkflowStepRun(tenantId, {
        ...step,
        id: `step-${randomUUID()}`,
        attempt: 1,
        status: 'running',
        output: { text: '第一次旧结果' },
        errorCode: undefined,
        approvalId: undefined,
        idempotencyKey: 'attempt-1',
        sideEffectUnknown: false,
        llmCalls: 0,
        toolCalls: 0,
        updatedAt: T2,
      })).toBe(true);
      expect(await store.getWorkflowStepRun(tenantId, runRecord.id, 'notify')).toMatchObject({
        attempt: 2,
        status: 'failed',
        output: { text: '第二次结果' },
        errorCode: 'WRITE_UNKNOWN',
        approvalId: 'approval-2',
        idempotencyKey: 'attempt-2',
        sideEffectUnknown: true,
        llmCalls: 2,
        toolCalls: 3,
        updatedAt: T1,
      });

      const current: WorkflowStepRunRecord = {
        ...step,
        id: `step-${randomUUID()}`,
        nodeId: 'notify-current',
        status: 'running',
        output: { text: '当前结果' },
        errorCode: undefined,
        sideEffectUnknown: false,
        updatedAt: T2,
      };
      expect(await store.upsertWorkflowStepRun(tenantId, current)).toBe(true);
      // 同一 attempt 的过期快照也不能回滚状态，但其中迟到的副作用标志必须生效。
      expect(await store.upsertWorkflowStepRun(tenantId, {
        ...current,
        status: 'failed',
        output: { text: '过期结果' },
        sideEffectUnknown: true,
        updatedAt: T1,
      })).toBe(true);
      expect(await store.getWorkflowStepRun(tenantId, runRecord.id, 'notify-current')).toMatchObject({
        attempt: 2,
        status: 'running',
        output: { text: '当前结果' },
        sideEffectUnknown: true,
        updatedAt: T2,
      });
    });

    it('缺失引用在步骤与运行上双端一致留痕', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const runRecord = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(runRecord)).toBe(true);
      const step: WorkflowStepRunRecord = {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'notify',
        attempt: 1,
        status: 'succeeded',
        output: { text: '结果' },
        sideEffectUnknown: false,
        missingRefs: ['nodes.review.output.text', 'input.note'],
        createdAt: T0,
        updatedAt: T1,
      };
      expect(await store.upsertWorkflowStepRun(tenantId, step)).toBe(true);
      expect((await store.getWorkflowStepRun(tenantId, runRecord.id, 'notify'))?.missingRefs)
        .toEqual(['nodes.review.output.text', 'input.note']);
      // 迟到的旧快照不得抹掉缺失引用留痕
      expect(await store.upsertWorkflowStepRun(tenantId, {
        ...step, id: `step-${randomUUID()}`, status: 'running', missingRefs: undefined, updatedAt: T0,
      })).toBe(true);
      expect((await store.getWorkflowStepRun(tenantId, runRecord.id, 'notify'))?.missingRefs)
        .toEqual(['nodes.review.output.text', 'input.note']);

      // 运行级汇总：写入后可直接从运行记录读到
      const started = await store.transitionWorkflowRun(tenantId, runRecord.id, 'queued', 0, {
        status: 'running', updatedAt: T1, missingRefs: ['input.note'],
      });
      expect(started?.missingRefs).toEqual(['input.note']);
      // 未显式提供时保留既有值
      const finished = await store.transitionWorkflowRun(tenantId, runRecord.id, 'running', 1, {
        status: 'succeeded', updatedAt: T2,
      });
      expect(finished?.missingRefs).toEqual(['input.note']);

      // 显式 null 表示清空
      const second = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(second)).toBe(true);
      await store.transitionWorkflowRun(tenantId, second.id, 'queued', 0, {
        status: 'running', updatedAt: T1, missingRefs: ['input.note'],
      });
      const cleared = await store.transitionWorkflowRun(tenantId, second.id, 'running', 1, {
        status: 'succeeded', updatedAt: T2, missingRefs: null,
      });
      expect(cleared?.missingRefs).toBeUndefined();
    });

    it('列表按游标分页，翻页不重不漏且限制单页上限', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);

      // 工作流：按 updatedAt 倒序翻页
      const workflowIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const record = workflow(`wf-${randomUUID()}`, tenantId);
        const stamp = new Date(Date.parse(T0) + index * 1000).toISOString();
        workflowIds.push(record.id);
        expect(await store.upsertWorkflow({ ...record, updatedAt: stamp, createdAt: stamp })).toBe(true);
      }
      const seenWorkflows: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        // private 工作流只有所有者可见，翻页必须带所有者身份（见 3.2）。
        const rows = await store.listWorkflows({ tenantId, ownerId: 'owner-1', limit: 2, cursor });
        if (rows.length === 0) break;
        seenWorkflows.push(...rows.map((row) => row.id));
        const last = rows[rows.length - 1];
        cursor = formatWorkflowCursor(last.updatedAt, last.id);
      }
      // 租户里共有 1 条 seed 工作流 + 5 条循环写入的工作流 = 6 条
      expect(seenWorkflows).toHaveLength(6);
      expect(new Set(seenWorkflows).size).toBe(6);
      expect(seenWorkflows).toContain(workflowIds[0]);

      // 运行：按 createdAt 倒序翻页
      const runIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const stamp = new Date(Date.parse(T0) + index * 1000).toISOString();
        const record = run(`run-${randomUUID()}`, seeded.workflow);
        record.createdAt = stamp;
        record.updatedAt = stamp;
        runIds.push(record.id);
        expect(await store.insertWorkflowRun(record)).toBe(true);
      }
      const seenRuns: string[] = [];
      cursor = undefined;
      for (let page = 0; page < 5; page += 1) {
        const rows = await store.listWorkflowRuns({ tenantId, limit: 2, cursor });
        if (rows.length === 0) break;
        seenRuns.push(...rows.map((row) => row.id));
        const last = rows[rows.length - 1];
        cursor = formatWorkflowCursor(last.createdAt, last.id);
      }
      expect(seenRuns).toHaveLength(3);
      expect(new Set(seenRuns).size).toBe(3);

      // 版本：按版本号翻页，游标是纯数字版本号
      for (let versionNo = 2; versionNo <= 4; versionNo += 1) {
        expect(await store.upsertWorkflowVersion(version(seeded.workflow.id, tenantId, versionNo))).toBe(true);
      }
      const firstPage = await store.listWorkflowVersions(tenantId, seeded.workflow.id, { limit: 2 });
      expect(firstPage.map((row) => row.version)).toEqual([1, 2]);
      const secondPage = await store.listWorkflowVersions(tenantId, seeded.workflow.id, {
        limit: 2,
        cursor: String(firstPage[firstPage.length - 1].version),
      });
      expect(secondPage.map((row) => row.version)).toEqual([3, 4]);

      // 步骤：按 createdAt + nodeId 翻页
      const runRecord = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(runRecord)).toBe(true);
      for (const nodeId of ['a', 'b', 'c']) {
        expect(await store.upsertWorkflowStepRun(tenantId, {
          id: `step-${randomUUID()}`,
          runId: runRecord.id,
          nodeId,
          attempt: 1,
          status: 'succeeded',
          sideEffectUnknown: false,
          createdAt: T0,
          updatedAt: T0,
        })).toBe(true);
      }
      const stepPage = await store.listWorkflowStepRuns(tenantId, runRecord.id, { limit: 2 });
      expect(stepPage.map((row) => row.nodeId)).toEqual(['a', 'b']);
      const stepPage2 = await store.listWorkflowStepRuns(tenantId, runRecord.id, {
        limit: 2,
        cursor: formatWorkflowCursor(stepPage[stepPage.length - 1].createdAt, stepPage[stepPage.length - 1].nodeId),
      });
      expect(stepPage2.map((row) => row.nodeId)).toEqual(['c']);

      // 模板目录与模板版本也使用相同的游标契约，不能只在实现里声明而未验证。
      const pagedTemplate = template(`tpl-${randomUUID()}`, 'tenant', tenantId);
      expect(await store.upsertTenantWorkflowTemplate(tenantId, pagedTemplate)).toBe(true);
      for (let versionNo = 1; versionNo <= 3; versionNo += 1) {
        expect(await store.upsertTenantWorkflowTemplateVersion(tenantId, {
          ...templateVersion(pagedTemplate.id),
          version: versionNo,
          checksum: `template-checksum-${versionNo}`,
        })).toBe(true);
      }
      for (let index = 0; index < 2; index += 1) {
        expect(await store.upsertTenantWorkflowTemplate(
          tenantId,
          template(`tpl-${randomUUID()}`, 'tenant', tenantId),
        )).toBe(true);
      }
      const seenTemplates: string[] = [];
      let templateCursor: string | undefined;
      for (let page = 0; page < 4; page += 1) {
        const rows = await store.listWorkflowTemplates(tenantId, { limit: 2, cursor: templateCursor });
        if (rows.length === 0) break;
        seenTemplates.push(...rows.map((row) => row.id));
        const last = rows[rows.length - 1];
        templateCursor = formatWorkflowCursor(last.updatedAt, last.id);
      }
      expect(seenTemplates).toHaveLength(3);
      expect(new Set(seenTemplates).size).toBe(3);
      const templateVersionPage = await store.listWorkflowTemplateVersions(tenantId, pagedTemplate.id, { limit: 2 });
      expect(templateVersionPage.map((row) => row.version)).toEqual([1, 2]);
      const templateVersionPage2 = await store.listWorkflowTemplateVersions(tenantId, pagedTemplate.id, {
        limit: 2,
        cursor: String(templateVersionPage[templateVersionPage.length - 1].version),
      });
      expect(templateVersionPage2.map((row) => row.version)).toEqual([3]);

      expect(resolveWorkflowListLimit(undefined)).toBe(50);
      expect(resolveWorkflowListLimit(0)).toBe(50);
      expect(resolveWorkflowListLimit(0.5)).toBe(1);
      expect(resolveWorkflowListLimit(1.9)).toBe(1);
      expect(resolveWorkflowListLimit(100_000)).toBe(WORKFLOW_LIST_LIMIT_MAX);
      expect(await store.listWorkflows({ tenantId, limit: 0.5, ownerId: 'owner-1' })).toHaveLength(1);

      // 单页上限：超出最大页大小按上限截断
      const capped = await store.listWorkflows({ tenantId, limit: 100_000, ownerId: 'owner-1' });
      expect(capped.length).toBeLessThanOrEqual(WORKFLOW_LIST_LIMIT_MAX);
      const defaultPage = await store.listWorkflows({ tenantId, ownerId: 'owner-1' });
      expect(defaultPage.length).toBeLessThanOrEqual(WORKFLOW_LIST_LIMIT_MAX);
    });

    it('已发布模板不允许被普通 upsert 改回草稿', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const platform = template(`tpl-${randomUUID()}`, 'platform');
      expect(await store.upsertPlatformWorkflowTemplate(platform)).toBe(true);
      expect(await store.upsertPlatformWorkflowTemplate({ ...platform, status: 'published' })).toBe(true);
      expect(await store.upsertPlatformWorkflowTemplate({ ...platform, status: 'draft', name: '下架' })).toBe(false);
      const stored = await store.getWorkflowTemplate(tenantId, platform.id);
      expect(stored?.status).toBe('published');
      expect(stored?.name).toBe(platform.name);
    });

    it('不可序列化的 JSON 字段抛出明确的领域错误', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow),
        input: undefined as unknown as Record<string, unknown>,
      })).rejects.toThrow(/运行输入/);
      await expect(store.upsertWorkflowVersion({
        ...version(seeded.workflow.id, tenantId, 9),
        definition: undefined as unknown as Record<string, unknown>,
      })).rejects.toThrow(/工作流定义/);

      // BigInt 与循环引用：必须给带字段名的领域错误，而不是 V8 原始异常（两端一致）。
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow),
        input: circular,
      })).rejects.toThrow(/字段 运行输入 必须是可序列化的 JSON 值/);
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow),
        input: { big: 1n } as unknown as Record<string, unknown>,
      })).rejects.toThrow(/字段 运行输入 必须是可序列化的 JSON 值/);
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow),
        input: undefined as unknown as Record<string, unknown>,
      })).rejects.toThrow(TypeError);
    });

    it('非规范时间戳写入后翻页不漏记录', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      // 同一时刻的两种文本写法：秒级 ISO 与毫秒级 ISO。
      const first = workflow(`wf-${randomUUID()}`, tenantId);
      const second = workflow(`wf-${randomUUID()}`, tenantId);
      expect(await store.upsertWorkflow({
        ...first, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      })).toBe(true);
      expect(await store.upsertWorkflow({
        ...second, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      })).toBe(true);

      const all = await store.listWorkflows({ tenantId, ownerId: 'owner-1' });
      expect(all).toHaveLength(2);
      // 写库前已归一化：两条记录的排序键文本必须完全一致
      expect(all.map((row) => row.updatedAt)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);

      // 单条翻页必须拿到另一条，不能漏记录
      const firstPage = await store.listWorkflows({ tenantId, ownerId: 'owner-1', limit: 1 });
      expect(firstPage).toHaveLength(1);
      const secondPage = await store.listWorkflows({
        tenantId,
        ownerId: 'owner-1',
        limit: 1,
        cursor: formatWorkflowCursor(firstPage[0].updatedAt, firstPage[0].id),
      });
      expect(secondPage).toHaveLength(1);
      expect(secondPage[0].id).not.toBe(firstPage[0].id);

      // 全量翻页不重不漏
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const rows = await store.listWorkflows({ tenantId, ownerId: 'owner-1', limit: 1, cursor });
        if (rows.length === 0) break;
        rows.forEach((row) => seen.add(row.id));
        cursor = formatWorkflowCursor(rows[rows.length - 1].updatedAt, rows[rows.length - 1].id);
      }
      expect(seen.size).toBe(2);
    });

    it('非法游标抛出明确错误，两端行为一致', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      // 时间部分不可解析：必须报错，不能静默降级为「从头开始」（那会让客户端拿到重复数据）
      await expect(store.listWorkflows({ tenantId, cursor: 'garbage|a' })).rejects.toThrow(/游标/);
      await expect(store.listWorkflowRuns({ tenantId, cursor: 'garbage|a' })).rejects.toThrow(/游标/);
      await expect(store.listWorkflowTemplates(tenantId, { cursor: 'garbage|a' })).rejects.toThrow(/游标/);
      await expect(store.listWorkflowStepRuns(tenantId, `run-${randomUUID()}`, { cursor: 'garbage|a' }))
        .rejects.toThrow(/游标/);
      // 结构非法同样不能静默降级
      await expect(store.listWorkflows({ tenantId, cursor: 'no-separator' })).rejects.toThrow(/游标/);
      await expect(store.listWorkflows({ tenantId, cursor: '|a' })).rejects.toThrow(/游标/);
      for (const cursor of ['garbage', '0', '-1', '1.5', '9007199254740992']) {
        await expect(store.listWorkflowVersions(tenantId, seeded.workflow.id, { cursor })).rejects.toThrow(/游标版本/);
        await expect(store.listWorkflowTemplateVersions(tenantId, 'template', { cursor })).rejects.toThrow(/游标版本/);
      }
      // 合法游标不受影响
      expect(await store.listWorkflows({ tenantId, ownerId: 'owner-1' })).toHaveLength(1);
      expect(seeded.workflow.id).toBeTruthy();
    });

    it('租户不能改写平台模板，也不能给平台模板写版本', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const platform = template(`tpl-${randomUUID()}`, 'platform');
      expect(await store.upsertPlatformWorkflowTemplate(platform)).toBe(true);

      // 租户写入入口不接受平台作用域
      expect(await store.upsertTenantWorkflowTemplate(tenantId, { ...platform, name: 'HIJACKED' })).toBe(false);
      // 即便伪装成租户作用域，冲突更新条件也会挡住库里已有的平台模板
      expect(await store.upsertTenantWorkflowTemplate(tenantId, {
        ...platform, scope: 'tenant', name: 'HIJACKED',
      })).toBe(false);
      const stored = await store.getWorkflowTemplate(tenantId, platform.id);
      expect(stored?.name).toBe(platform.name);
      expect(stored?.status).toBe('draft');
      expect(stored?.scope).toBe('platform');

      // 平台模板的版本只能走平台入口
      expect(await store.upsertTenantWorkflowTemplateVersion(tenantId, templateVersion(platform.id))).toBe(false);
      expect(await store.getWorkflowTemplateVersion(tenantId, platform.id, 1)).toBeUndefined();
      expect(await store.upsertPlatformWorkflowTemplateVersion(templateVersion(platform.id))).toBe(true);
      expect((await store.getWorkflowTemplateVersion(tenantId, platform.id, 1))?.checksum)
        .toBe('template-checksum-1');
    });

    it('审核中的版本被锁定，只能通过驳回通道回到可编辑状态', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const workflowId = seeded.workflow.id;
      const review = version(workflowId, tenantId, 5);
      expect(await store.upsertWorkflowVersion(review)).toBe(true);
      // 审核中只能由显式提交通道产生：普通 upsert 写不进 in_review。
      expect(await store.upsertWorkflowVersion({ ...review, status: 'in_review', checksum: 'checksum-review' })).toBe(false);
      expect(await store.submitWorkflowVersionForReview(tenantId, workflowId, 5)).toBe(true);

      // 审核中的版本不能被普通 upsert 改写
      expect(await store.upsertWorkflowVersion({ ...review, status: 'draft', checksum: 'hack' })).toBe(false);
      const locked = await store.getWorkflowVersion(tenantId, workflowId, 5);
      expect(locked?.status).toBe('in_review');
      expect(locked?.checksum).toBe(review.checksum);

      // 驳回：记录审核人和意见
      expect(await store.rejectWorkflowVersion(tenantId, workflowId, 5, {
        reviewer: 'admin-1', comment: '缺少人工审核节点', at: T1,
      })).toBe(true);
      const rejected = await store.getWorkflowVersion(tenantId, workflowId, 5);
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.reviewedBy).toBe('admin-1');
      expect(rejected?.reviewComment).toBe('缺少人工审核节点');
      expect(rejected?.reviewedAt).toBe(T1);

      // 非审核中状态不能再驳回；跨租户驳回无效
      expect(await store.rejectWorkflowVersion(tenantId, workflowId, 5, {
        reviewer: 'admin-1', comment: '重复驳回', at: T2,
      })).toBe(false);
      expect(await store.rejectWorkflowVersion(`other-${tenantId}`, workflowId, 5, {
        reviewer: 'admin-1', comment: '跨租户', at: T2,
      })).toBe(false);

      // 驳回后草稿重新开放
      expect(await store.upsertWorkflowVersion({ ...review, status: 'draft', checksum: 'checksum-fixed' })).toBe(true);
      expect((await store.getWorkflowVersion(tenantId, workflowId, 5))?.status).toBe('draft');
      expect((await store.getWorkflowVersion(tenantId, workflowId, 5))?.checksum).toBe('checksum-fixed');
    });

    it('审核通过后走显式发布通道，发布的就是审核时的那一份定义', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const workflowId = seeded.workflow.id;
      const review = version(workflowId, tenantId, 6);
      expect(await store.upsertWorkflowVersion({
        ...review, definition: { schemaVersion: 1, name: '审核版', nodes: [], edges: [] },
        checksum: 'checksum-review',
      })).toBe(true);
      // 提交审核走显式通道：定义与校验和在提交前定稿，通道本身不改内容。
      expect(await store.submitWorkflowVersionForReview(tenantId, workflowId, 6)).toBe(true);

      // 审核中的版本不能直接 upsert 成 published
      expect(await store.upsertWorkflowVersion({
        ...review, status: 'published', checksum: 'checksum-other',
      })).toBe(false);

      // 显式发布通道：只改状态与发布信息，定义与校验和保持审核时的那一份
      expect(await store.publishWorkflowVersion(tenantId, workflowId, 6, {
        reviewer: 'admin-1', at: T2,
      })).toBe(true);
      const published = await store.getWorkflowVersion(tenantId, workflowId, 6);
      expect(published?.status).toBe('published');
      expect(published?.checksum).toBe('checksum-review');
      expect(published?.publishedBy).toBe('admin-1');
      expect(published?.publishedAt).toBe(T2);
      expect(published?.reviewedBy).toBe('admin-1');

      // 已发布版本不可再改；跨租户发布无效
      expect(await store.upsertWorkflowVersion({ ...review, status: 'draft', checksum: 'hack' })).toBe(false);
      expect(await store.publishWorkflowVersion(tenantId, workflowId, 6, {
        reviewer: 'admin-1', at: T3,
      })).toBe(false);
      expect(await store.publishWorkflowVersion(`other-${tenantId}`, workflowId, 6, {
        reviewer: 'admin-1', at: T3,
      })).toBe(false);
    });

    it('可见范围：private 仅所有者可见，department 按部门，tenant 全租户可见', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const privateRecord = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'private' as const };
      const deptRecord = {
        ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-2'),
        visibility: 'department' as const,
        deptId: 'dept-a',
      };
      const tenantRecord = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-3'), visibility: 'tenant' as const };
      expect(await store.upsertWorkflow(privateRecord)).toBe(true);
      expect(await store.upsertWorkflow(deptRecord)).toBe(true);
      expect(await store.upsertWorkflow(tenantRecord)).toBe(true);
      // 部门归属必须真的落库
      expect((await store.getWorkflow(tenantId, deptRecord.id))?.deptId).toBe('dept-a');

      // 调用者视角：本人 private + 同部门 department + 租户级 tenant 都可见
      const member = await store.listWorkflows({
        tenantId, actor: { userId: 'owner-1', departmentIds: ['dept-a'] },
      });
      expect(new Set(member.map((row) => row.id)))
        .toEqual(new Set([privateRecord.id, deptRecord.id, tenantRecord.id]));

      // 他人的 private 与跨部门的 department 都不可见
      const other = await store.listWorkflows({
        tenantId, actor: { userId: 'owner-9', departmentIds: ['dept-b'] },
      });
      expect(other.map((row) => row.id)).toEqual([tenantRecord.id]);

      // ownerId 退化为纯 owner 过滤：带上它不会把可见范围限死为本人
      const filtered = await store.listWorkflows({
        tenantId, ownerId: 'owner-3', actor: { userId: 'owner-1', departmentIds: ['dept-a'] },
      });
      expect(filtered.map((row) => row.id)).toEqual([tenantRecord.id]);

      // 管理员可见他人 private 与 department
      const admin = await store.listWorkflows({ tenantId, actor: { userId: 'admin-1', isAdmin: true } });
      expect(new Set(admin.map((row) => row.id)))
        .toEqual(new Set([privateRecord.id, deptRecord.id, tenantRecord.id]));

      // 不带 actor = 平台内部可信视角：不被可见范围收窄
      const internal = await store.listWorkflows({ tenantId });
      expect(new Set(internal.map((row) => row.id)))
        .toEqual(new Set([privateRecord.id, deptRecord.id, tenantRecord.id]));

      // 可见性白名单
      const onlyTenant = await store.listWorkflows({ tenantId, actor: { userId: 'owner-1' }, visibility: ['tenant'] });
      expect(onlyTenant.map((row) => row.id)).toEqual([tenantRecord.id]);
      const onlyPrivate = await store.listWorkflows({
        tenantId, actor: { userId: 'owner-1' }, visibility: ['private'],
      });
      expect(onlyPrivate.map((row) => row.id)).toEqual([privateRecord.id]);
    });

    it('工作流所有权不可夺取：非所有者与非管理员不能改写他人工作流', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const ownerRecord = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'private' as const };
      expect(await store.upsertWorkflow(ownerRecord)).toBe(true);

      // 同租户的其他成员 upsert：既不能夺走所有权，也不能放宽可见范围
      expect(await store.upsertWorkflow(
        { ...ownerRecord, ownerId: 'owner-2', visibility: 'tenant', name: '越权改写' },
        { userId: 'owner-2' },
      )).toBe(false);
      const untouched = await store.getWorkflow(tenantId, ownerRecord.id);
      expect(untouched?.ownerId).toBe('owner-1');
      expect(untouched?.visibility).toBe('private');
      expect(untouched?.name).toBe(ownerRecord.name);

      // 所有者本人可以改写自己的可见范围，但 owner_id 创建后不可变
      expect(await store.upsertWorkflow(
        { ...ownerRecord, ownerId: 'owner-3', visibility: 'tenant', name: '本人改写' },
        { userId: 'owner-1' },
      )).toBe(true);
      const afterOwner = await store.getWorkflow(tenantId, ownerRecord.id);
      expect(afterOwner?.ownerId).toBe('owner-1');
      expect(afterOwner?.visibility).toBe('tenant');
      expect(afterOwner?.name).toBe('本人改写');

      // 管理员可以改写他人工作流，但同样改不了 owner_id
      expect(await store.upsertWorkflow(
        { ...ownerRecord, name: '管理员改写' },
        { userId: 'admin-1', isAdmin: true },
      )).toBe(true);
      const afterAdmin = await store.getWorkflow(tenantId, ownerRecord.id);
      expect(afterAdmin?.name).toBe('管理员改写');
      expect(afterAdmin?.ownerId).toBe('owner-1');

      // 不带 actor = 平台内部可信写入，不受所有权限制
      expect(await store.upsertWorkflow({ ...ownerRecord, name: '内部改写' })).toBe(true);
      expect((await store.getWorkflow(tenantId, ownerRecord.id))?.name).toBe('内部改写');

      // 删除也是「编辑」：非所有者删不掉，所有者与管理员可以删
      const deleteTarget = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'private' as const };
      expect(await store.upsertWorkflow(deleteTarget)).toBe(true);
      expect(await store.deleteWorkflow(tenantId, deleteTarget.id, T1, { userId: 'owner-2' })).toBe(false);
      expect((await store.getWorkflow(tenantId, deleteTarget.id))?.deletedAt).toBeUndefined();
      expect(await store.deleteWorkflow(tenantId, deleteTarget.id, T1, { userId: 'owner-1' })).toBe(true);
      // 软删除是终态：单条读与列表读口径一致，默认都读不到已删除的工作流。
      expect(await store.getWorkflow(tenantId, deleteTarget.id)).toBeUndefined();
      const listed = await store.listWorkflows({ tenantId, ownerId: 'owner-1' });
      expect(listed.map((row) => row.id)).not.toContain(deleteTarget.id);
      // 需要看到删除痕迹时显式要 includeDeleted。
      expect((await store.getWorkflow(tenantId, deleteTarget.id, undefined, { includeDeleted: true }))?.deletedAt)
        .toBe(T1);
    });

    it('单条读按所有权与可见范围过滤：他人 private 工作流与他人运行不可读', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const ownerRecord = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'private' as const };
      const sharedRecord = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-2'), visibility: 'tenant' as const };
      expect(await store.upsertWorkflow(ownerRecord)).toBe(true);
      expect(await store.upsertWorkflow(sharedRecord)).toBe(true);

      // 他人 private 工作流读不到；所有者与管理员读得到
      expect(await store.getWorkflow(tenantId, ownerRecord.id, { userId: 'owner-2' })).toBeUndefined();
      expect(await store.getWorkflow(tenantId, ownerRecord.id, { userId: 'owner-1' })).toBeDefined();
      expect(await store.getWorkflow(tenantId, ownerRecord.id, { userId: 'admin-1', isAdmin: true })).toBeDefined();
      // tenant 可见范围对同租户成员可见
      expect(await store.getWorkflow(tenantId, sharedRecord.id, { userId: 'owner-3' })).toBeDefined();
      // 跨租户一律读不到
      expect(await store.getWorkflow(`other-${tenantId}`, ownerRecord.id, { userId: 'owner-1' })).toBeUndefined();

      // 版本跟随所属工作流：private 工作流的版本对他人不可读
      const privateVersion = version(ownerRecord.id, tenantId, 1);
      expect(await store.upsertWorkflowVersion(privateVersion)).toBe(true);
      expect(await store.getWorkflowVersion(tenantId, ownerRecord.id, 1, { userId: 'owner-2' })).toBeUndefined();
      expect(await store.getWorkflowVersion(tenantId, ownerRecord.id, 1, { userId: 'owner-1' })).toBeDefined();
      expect(await store.getWorkflowVersion(tenantId, ownerRecord.id, 1, { userId: 'admin-1', isAdmin: true })).toBeDefined();
      expect(await store.listWorkflowVersions(tenantId, ownerRecord.id, { actor: { userId: 'owner-2' } })).toEqual([]);
      expect(await store.listWorkflowVersions(tenantId, ownerRecord.id, { actor: { userId: 'owner-1' } })).toHaveLength(1);

      // 运行：发起人本人与管理员可见，他人不可见（运行输入可能含敏感字段，见 R6）
      const runRecord = run(`run-${randomUUID()}`, ownerRecord);
      runRecord.input = { secret: '机密输入' };
      expect(await store.insertWorkflowRun(runRecord)).toBe(true);
      expect(await store.getWorkflowRun(tenantId, runRecord.id, { userId: 'owner-1' })).toBeDefined();
      expect(await store.getWorkflowRun(tenantId, runRecord.id, { userId: 'owner-2' })).toBeUndefined();
      expect(await store.getWorkflowRun(tenantId, runRecord.id, { userId: 'admin-1', isAdmin: true })).toBeDefined();
      // 列表同样按运行可见范围过滤
      expect(await store.listWorkflowRuns({ tenantId, actor: { userId: 'owner-2' } })).toEqual([]);
      expect(await store.listWorkflowRuns({ tenantId, actor: { userId: 'owner-1' } })).toHaveLength(1);

      // 步骤输出跟随其所属运行：他人读不到
      const step: WorkflowStepRunRecord = {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'review',
        attempt: 1,
        status: 'succeeded',
        output: { text: '敏感结论' },
        sideEffectUnknown: false,
        createdAt: T0,
        updatedAt: T0,
      };
      expect(await store.upsertWorkflowStepRun(tenantId, step)).toBe(true);
      expect(await store.getWorkflowStepRun(tenantId, runRecord.id, 'review', { userId: 'owner-2' })).toBeUndefined();
      expect(await store.getWorkflowStepRun(tenantId, runRecord.id, 'review', { userId: 'owner-1' })).toBeDefined();
      expect(await store.getWorkflowStepRun(tenantId, runRecord.id, 'review', { userId: 'admin-1', isAdmin: true })).toBeDefined();
      expect(await store.listWorkflowStepRuns(tenantId, runRecord.id, { actor: { userId: 'owner-2' } })).toEqual([]);
      expect(await store.listWorkflowStepRuns(tenantId, runRecord.id, { actor: { userId: 'owner-1' } })).toHaveLength(1);
    });

    it('版本状态机：普通 upsert 进不了审核中或已发布，只能走显式通道', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const record = workflow(`wf-${randomUUID()}`, tenantId);
      expect(await store.upsertWorkflow(record)).toBe(true);
      const draft = version(record.id, tenantId, 1);
      expect(await store.upsertWorkflowVersion(draft)).toBe(true);

      // 目标状态为 in_review / published：一律拒绝，旧行不变
      expect(await store.upsertWorkflowVersion({ ...draft, status: 'in_review' })).toBe(false);
      expect(await store.upsertWorkflowVersion({
        ...draft, status: 'published', publishedBy: 'admin-1', publishedAt: T1,
      })).toBe(false);
      const untouched = await store.getWorkflowVersion(tenantId, record.id, 1);
      expect(untouched?.status).toBe('draft');
      expect(untouched?.reviewedBy).toBeUndefined();
      expect(untouched?.publishedBy).toBeUndefined();
      expect(untouched?.publishedAt).toBeUndefined();

      // 提交审核：只改状态，不写审核与发布字段
      expect(await store.submitWorkflowVersionForReview(tenantId, record.id, 1)).toBe(true);
      const inReview = await store.getWorkflowVersion(tenantId, record.id, 1);
      expect(inReview?.status).toBe('in_review');
      expect(inReview?.reviewedBy).toBeUndefined();
      expect(inReview?.publishedBy).toBeUndefined();
      // 重复提交与跨租户提交都无效
      expect(await store.submitWorkflowVersionForReview(tenantId, record.id, 1)).toBe(false);
      expect(await store.submitWorkflowVersionForReview(`other-${tenantId}`, record.id, 1)).toBe(false);

      // 显式发布通道：发布的是审核时的那一份，并留下审核人与发布时间
      expect(await store.publishWorkflowVersion(tenantId, record.id, 1, { reviewer: 'admin-1', at: T2 })).toBe(true);
      const published = await store.getWorkflowVersion(tenantId, record.id, 1);
      expect(published?.status).toBe('published');
      expect(published?.reviewedBy).toBe('admin-1');
      expect(published?.publishedBy).toBe('admin-1');
      expect(published?.publishedAt).toBe(T2);
      // 已发布不可再被普通 upsert 改写
      expect(await store.upsertWorkflowVersion({ ...draft, checksum: 'tampered' })).toBe(false);
      expect((await store.getWorkflowVersion(tenantId, record.id, 1))?.checksum).toBe(draft.checksum);
    });

    it('CHECK 组合非法时两端都抛统一领域错误', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);

      // 运行模式与定义快照的组合非法
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow, 'published'),
        definitionSnapshot: { unexpected: true },
      })).rejects.toThrow(TypeError);
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow, 'published'),
        definitionSnapshot: { unexpected: true },
      })).rejects.toThrow(/definition_snapshot/);
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow, 'debug'),
        definitionSnapshot: undefined,
      })).rejects.toThrow(/definition_snapshot/);

      // 可见性取值域非法
      await expect(store.upsertWorkflow({
        ...workflow(`wf-${randomUUID()}`, tenantId),
        visibility: 'secret' as unknown as WorkflowVisibility,
      })).rejects.toThrow(/visibility/);

      // 步骤次数与调用计数非法
      const runRecord = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(runRecord)).toBe(true);
      await expect(store.upsertWorkflowStepRun(tenantId, {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'a',
        attempt: 0,
        status: 'running',
        sideEffectUnknown: false,
        createdAt: T0,
        updatedAt: T0,
      })).rejects.toThrow(/attempt/);
      await expect(store.upsertWorkflowStepRun(tenantId, {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'a',
        attempt: 1,
        status: 'running',
        sideEffectUnknown: false,
        llmCalls: -1,
        createdAt: T0,
        updatedAt: T0,
      })).rejects.toThrow(/llm_calls/);
      await expect(store.upsertWorkflowStepRun(tenantId, {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'a',
        attempt: 1,
        status: 'running',
        sideEffectUnknown: false,
        toolCalls: -1,
        createdAt: T0,
        updatedAt: T0,
      })).rejects.toThrow(/tool_calls/);

      // 模板作用域与租户归属互斥
      await expect(store.upsertPlatformWorkflowTemplate({
        ...template(`tpl-${randomUUID()}`, 'platform'),
        tenantId,
      })).rejects.toThrow(/scope/);
    });

    it('运行记录写入时保留 missingRefs', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const record = run(`run-${randomUUID()}`, seeded.workflow);
      record.missingRefs = ['input.note', 'nodes.review.output.text'];
      expect(await store.insertWorkflowRun(record)).toBe(true);
      const stored = await store.getWorkflowRun(tenantId, record.id);
      expect(stored?.missingRefs).toEqual(['input.note', 'nodes.review.output.text']);
    });

    it('脏 JSON 列返回 undefined，不能让整页查询失败', async () => {
      expect(parseStringArray('{不是 JSON')).toBeUndefined();
      expect(parseStringArray('{"a":1}')).toBeUndefined();
      expect(parseStringArray('[1,"a"]')).toBeUndefined();
      expect(parseStringArray('[null]')).toBeUndefined();
      expect(parseStringArray('[{"ref":"input.note"}]')).toBeUndefined();
      expect(parseStringArray(null)).toBeUndefined();
      expect(parseStringArray(undefined)).toBeUndefined();
      expect(parseStringArray('["a","b"]')).toEqual(['a', 'b']);
    });

    it('版本写路径带身份判定：非所有者改不动草稿，非管理员做不了审核发布', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const ownerRecord = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'private' as const };
      expect(await store.upsertWorkflow(ownerRecord)).toBe(true);
      const draft = version(ownerRecord.id, tenantId, 1);

      // 非所有者既不能新建草稿，也不能改写别人的草稿
      expect(await store.upsertWorkflowVersion(draft, { userId: 'owner-2' })).toBe(false);
      expect(await store.getWorkflowVersion(tenantId, ownerRecord.id, 1)).toBeUndefined();

      // 所有者本人可以写草稿并提交审核
      expect(await store.upsertWorkflowVersion(draft, { userId: 'owner-1' })).toBe(true);
      expect(await store.submitWorkflowVersionForReview(tenantId, ownerRecord.id, 1, { userId: 'owner-2' })).toBe(false);
      expect(await store.submitWorkflowVersionForReview(tenantId, ownerRecord.id, 1, { userId: 'owner-1' })).toBe(true);

      // 审核与发布是管理员专属动作：所有者自审自批必须无效
      expect(await store.rejectWorkflowVersion(
        tenantId, ownerRecord.id, 1, { reviewer: 'owner-1', comment: '自审通过', at: T1 }, { userId: 'owner-1' },
      )).toBe(false);
      expect(await store.publishWorkflowVersion(
        tenantId, ownerRecord.id, 1, { reviewer: 'owner-1', at: T1 }, { userId: 'owner-1' },
      )).toBe(false);
      const pending = await store.getWorkflowVersion(tenantId, ownerRecord.id, 1);
      expect(pending?.status).toBe('in_review');
      expect(pending?.reviewedBy).toBeUndefined();
      expect(pending?.publishedBy).toBeUndefined();

      // 管理员可以审核与发布
      expect(await store.rejectWorkflowVersion(
        tenantId, ownerRecord.id, 1, { reviewer: 'admin-1', comment: '缺少人工审核节点', at: T1 },
        { userId: 'admin-1', isAdmin: true },
      )).toBe(true);
      expect(await store.upsertWorkflowVersion(
        { ...draft, status: 'draft', checksum: 'checksum-fixed' }, { userId: 'owner-1' },
      )).toBe(true);
      expect(await store.submitWorkflowVersionForReview(tenantId, ownerRecord.id, 1, { userId: 'owner-1' })).toBe(true);
      expect(await store.publishWorkflowVersion(
        tenantId, ownerRecord.id, 1, { reviewer: 'admin-1', at: T2 }, { userId: 'admin-1', isAdmin: true },
      )).toBe(true);
      const published = await store.getWorkflowVersion(tenantId, ownerRecord.id, 1);
      expect(published?.status).toBe('published');
      expect(published?.reviewedBy).toBe('admin-1');
      expect(published?.publishedBy).toBe('admin-1');

      // 省略 actor = 平台内部可信操作，不受所有权限制
      expect(await store.upsertWorkflowVersion(version(ownerRecord.id, tenantId, 2))).toBe(true);
      expect(await store.submitWorkflowVersionForReview(tenantId, ownerRecord.id, 2)).toBe(true);
    });

    it('普通 upsert 不写审核与发布留痕：伪造与抹除都无效', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const ownerRecord = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'private' as const };
      expect(await store.upsertWorkflow(ownerRecord)).toBe(true);
      const draft = version(ownerRecord.id, tenantId, 1);

      // 草稿态写入时携带伪造的审核与发布留痕：必须被丢弃
      expect(await store.upsertWorkflowVersion({
        ...draft,
        reviewedBy: 'admin-1',
        reviewedAt: T1,
        reviewComment: '伪造审核意见',
        publishedBy: 'admin-1',
        publishedAt: T1,
      })).toBe(true);
      const fresh = await store.getWorkflowVersion(tenantId, ownerRecord.id, 1);
      expect(fresh?.reviewedBy).toBeUndefined();
      expect(fresh?.reviewedAt).toBeUndefined();
      expect(fresh?.reviewComment).toBeUndefined();
      expect(fresh?.publishedBy).toBeUndefined();
      expect(fresh?.publishedAt).toBeUndefined();

      // 驳回后留下真实审核意见，普通 upsert 不得把它抹掉
      expect(await store.submitWorkflowVersionForReview(tenantId, ownerRecord.id, 1)).toBe(true);
      expect(await store.rejectWorkflowVersion(
        tenantId, ownerRecord.id, 1, { reviewer: 'admin-1', comment: '缺少人工审核节点', at: T1 },
      )).toBe(true);
      expect(await store.upsertWorkflowVersion({ ...draft, status: 'rejected', checksum: 'checksum-fixed' })).toBe(true);
      const rejected = await store.getWorkflowVersion(tenantId, ownerRecord.id, 1);
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.reviewedBy).toBe('admin-1');
      expect(rejected?.reviewComment).toBe('缺少人工审核节点');
      expect(rejected?.reviewedAt).toBe(T1);
      expect(rejected?.publishedBy).toBeUndefined();
    });

    it('剩余 CHECK 在两端都前置为统一领域错误', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(store, tenantId);
      const workflowId = seeded.workflow.id;

      // 版本号与版本状态
      await expect(store.upsertWorkflowVersion({ ...version(workflowId, tenantId, 1), version: 0 }))
        .rejects.toThrow(/version/);
      await expect(store.upsertWorkflowVersion({
        ...version(workflowId, tenantId, 1),
        status: 'archived' as unknown as WorkflowVersionRecord['status'],
      })).rejects.toThrow(/status/);

      // 运行状态与乐观锁版本
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow),
        status: 'unknown' as unknown as WorkflowRunRecord['status'],
      })).rejects.toThrow(/status/);
      await expect(store.insertWorkflowRun({
        ...run(`run-${randomUUID()}`, seeded.workflow),
        lockVersion: -1,
      })).rejects.toThrow(/lock_version/);

      // 步骤状态与运行转换状态
      const runRecord = run(`run-${randomUUID()}`, seeded.workflow);
      expect(await store.insertWorkflowRun(runRecord)).toBe(true);
      await expect(store.transitionWorkflowRun(tenantId, runRecord.id, 'queued', 0, {
        status: 'unknown' as unknown as WorkflowRunRecord['status'], updatedAt: T1,
      })).rejects.toThrow(/status/);
      await expect(store.transitionWorkflowRun(tenantId, runRecord.id, 'queued', -1, {
        status: 'running', updatedAt: T1,
      })).rejects.toThrow(/lock_version/);
      await expect(store.upsertWorkflowStepRun(tenantId, {
        id: `step-${randomUUID()}`,
        runId: runRecord.id,
        nodeId: 'a',
        attempt: 1,
        status: 'unknown' as unknown as WorkflowStepRunRecord['status'],
        sideEffectUnknown: false,
        createdAt: T0,
        updatedAt: T0,
      })).rejects.toThrow(/status/);

      // 模板状态与模板版本号
      const tenantTemplate = template(`tpl-${randomUUID()}`, 'tenant', tenantId);
      expect(await store.upsertTenantWorkflowTemplate(tenantId, tenantTemplate)).toBe(true);
      await expect(store.upsertTenantWorkflowTemplate(tenantId, {
        ...tenantTemplate,
        status: 'archived' as unknown as WorkflowTemplateRecord['status'],
      })).rejects.toThrow(/status/);
      expect(await store.upsertTenantWorkflowTemplateVersion(tenantId, templateVersion(tenantTemplate.id))).toBe(true);
      await expect(store.upsertTenantWorkflowTemplateVersion(tenantId, {
        ...templateVersion(tenantTemplate.id),
        version: 0,
      })).rejects.toThrow(/version/);
      await expect(store.upsertTenantWorkflowTemplateVersion(tenantId, {
        ...templateVersion(tenantTemplate.id),
        status: 'archived' as unknown as WorkflowTemplateVersionRecord['status'],
      })).rejects.toThrow(/status/);
    });

    it('新建工作流的所有者取自调用者身份，客户端不能伪造', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const record = { ...workflow(`wf-${randomUUID()}`, tenantId, 'victim-1'), visibility: 'tenant' as const };
      // 调用者创建工作流：所有者必须落到调用者本人名下
      expect(await store.upsertWorkflow(record, { userId: 'attacker-1' })).toBe(true);
      expect((await store.getWorkflow(tenantId, record.id))?.ownerId).toBe('attacker-1');

      // 管理员可以代他人维护：所有者按传入值落库
      const adminCreated = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-2'), visibility: 'tenant' as const };
      expect(await store.upsertWorkflow(adminCreated, { userId: 'admin-1', isAdmin: true })).toBe(true);
      expect((await store.getWorkflow(tenantId, adminCreated.id))?.ownerId).toBe('owner-2');

      // 管理员未指定所有者时退回管理员本人，避免出现「无人拥有」的工作流
      const adminDefault = workflow(`wf-${randomUUID()}`, tenantId, '');
      expect(await store.upsertWorkflow(adminDefault, { userId: 'admin-1', isAdmin: true })).toBe(true);
      expect((await store.getWorkflow(tenantId, adminDefault.id))?.ownerId).toBe('admin-1');

      // 不带 actor = 平台内部可信写入，沿用记录自带的所有者
      const internal = workflow(`wf-${randomUUID()}`, tenantId, 'owner-9');
      expect(await store.upsertWorkflow(internal)).toBe(true);
      expect((await store.getWorkflow(tenantId, internal.id))?.ownerId).toBe('owner-9');
    });

    it('草稿版本只对所有者与管理员可见，已发布版本跟随工作流可见范围', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const shared = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'tenant' as const };
      expect(await store.upsertWorkflow(shared)).toBe(true);
      expect(await store.upsertWorkflowVersion(version(shared.id, tenantId, 1))).toBe(true);

      // 工作流对同租户成员可见，但草稿版本只对所有者与管理员可见
      expect(await store.getWorkflow(tenantId, shared.id, { userId: 'member-2' })).toBeDefined();
      expect(await store.getWorkflowVersion(tenantId, shared.id, 1, { userId: 'member-2' })).toBeUndefined();
      expect(await store.listWorkflowVersions(tenantId, shared.id, { actor: { userId: 'member-2' } })).toEqual([]);
      expect(await store.getWorkflowVersion(tenantId, shared.id, 1, { userId: 'owner-1' })).toBeDefined();
      expect(await store.getWorkflowVersion(tenantId, shared.id, 1, { userId: 'admin-1', isAdmin: true })).toBeDefined();

      // 发布后同租户成员可见该版本
      expect(await store.submitWorkflowVersionForReview(tenantId, shared.id, 1)).toBe(true);
      expect(await store.publishWorkflowVersion(tenantId, shared.id, 1, { reviewer: 'admin-1', at: T1 })).toBe(true);
      expect(await store.getWorkflowVersion(tenantId, shared.id, 1, { userId: 'member-2' })).toBeDefined();
      expect(await store.listWorkflowVersions(tenantId, shared.id, { actor: { userId: 'member-2' } })).toHaveLength(1);

      // 私有工作流的已发布版本同样不对外可见
      const priv = { ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-1'), visibility: 'private' as const };
      expect(await store.upsertWorkflow(priv)).toBe(true);
      expect(await store.upsertWorkflowVersion(version(priv.id, tenantId, 1))).toBe(true);
      expect(await store.submitWorkflowVersionForReview(tenantId, priv.id, 1)).toBe(true);
      expect(await store.publishWorkflowVersion(tenantId, priv.id, 1, { reviewer: 'admin-1', at: T1 })).toBe(true);
      expect(await store.getWorkflowVersion(tenantId, priv.id, 1, { userId: 'member-2' })).toBeUndefined();
    });

    it('部门归属取自调用者身份，不能伪造为其他部门', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const inferred = {
        ...workflow(`wf-${randomUUID()}`, tenantId),
        visibility: 'department' as const,
      };
      expect(await store.upsertWorkflow(inferred, {
        userId: 'owner-1', departmentIds: ['dept-a'],
      })).toBe(true);
      expect(await store.getWorkflow(tenantId, inferred.id)).toMatchObject({
        ownerId: 'owner-1', deptId: 'dept-a',
      });

      const spoofed = {
        ...workflow(`wf-${randomUUID()}`, tenantId),
        visibility: 'department' as const,
        deptId: 'dept-b',
      };
      expect(await store.upsertWorkflow(spoofed, {
        userId: 'attacker-1', departmentIds: ['dept-a'],
      })).toBe(false);
      expect(await store.getWorkflow(tenantId, spoofed.id)).toBeUndefined();

      const ambiguous = {
        ...workflow(`wf-${randomUUID()}`, tenantId),
        visibility: 'department' as const,
      };
      expect(await store.upsertWorkflow(ambiguous, {
        userId: 'owner-2', departmentIds: ['dept-a', 'dept-b'],
      })).toBe(false);
      expect(await store.upsertWorkflow({ ...ambiguous, deptId: 'dept-b' }, {
        userId: 'owner-2', departmentIds: ['dept-a', 'dept-b'],
      })).toBe(true);

      expect(await store.upsertWorkflow(spoofed, { userId: 'admin-1', isAdmin: true })).toBe(true);
      expect((await store.getWorkflow(tenantId, spoofed.id))?.deptId).toBe('dept-b');
    });

    it('版本作者、审核人与发布人均绑定 actor，禁止自审与越权直发', async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const owned = workflow(`wf-${randomUUID()}`, tenantId, 'owner-1');
      expect(await store.upsertWorkflow(owned)).toBe(true);
      expect(await store.upsertWorkflowVersion({
        ...version(owned.id, tenantId), createdBy: 'forged-author',
      }, { userId: 'owner-1' })).toBe(true);
      expect((await store.getWorkflowVersion(tenantId, owned.id, 1))?.createdBy).toBe('owner-1');
      expect(await store.submitWorkflowVersionForReview(tenantId, owned.id, 1, { userId: 'owner-1' })).toBe(true);

      const self = { userId: 'owner-1', isAdmin: true };
      expect(await store.rejectWorkflowVersion(
        tenantId, owned.id, 1,
        { reviewer: 'forged-reviewer', comment: '自审', at: T1 }, self,
      )).toBe(false);
      expect(await store.publishWorkflowVersion(
        tenantId, owned.id, 1, { reviewer: 'forged-reviewer', at: T1 }, self,
      )).toBe(false);
      expect((await store.getWorkflowVersion(tenantId, owned.id, 1))?.status).toBe('in_review');

      const reviewer = { userId: 'admin-1', isAdmin: true };
      expect(await store.publishWorkflowVersion(
        tenantId, owned.id, 1, { reviewer: 'forged-reviewer', at: T2 }, reviewer,
      )).toBe(true);
      expect(await store.getWorkflowVersion(tenantId, owned.id, 1)).toMatchObject({
        status: 'published', reviewedBy: 'admin-1', publishedBy: 'admin-1',
      });

      const adminOwned = workflow(`wf-${randomUUID()}`, tenantId, 'admin-2');
      expect(await store.upsertWorkflow(adminOwned)).toBe(true);
      expect(await store.upsertWorkflowVersion(
        { ...version(adminOwned.id, tenantId), createdBy: 'forged-author' },
        { userId: 'admin-2', isAdmin: true },
      )).toBe(true);
      expect(await store.submitWorkflowVersionForReview(
        tenantId, adminOwned.id, 1, { userId: 'admin-2', isAdmin: true },
      )).toBe(false);
      expect(await store.publishWorkflowVersion(
        tenantId, adminOwned.id, 1, { reviewer: 'forged-reviewer', at: T2 }, reviewer,
      )).toBe(false);
      expect(await store.publishWorkflowVersion(
        tenantId, adminOwned.id, 1, { reviewer: 'forged-reviewer', at: T2 },
        { userId: 'admin-2', isAdmin: true },
      )).toBe(true);
      expect((await store.getWorkflowVersion(tenantId, adminOwned.id, 1))?.publishedBy).toBe('admin-2');
    });

    it('禁止自审看两列：管理员覆盖内容后不能自审自发', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'private' as const,
          })).toBe(true);
          expect(await store.upsertWorkflowVersion({
            ...version(wfId, tenantId, 1), checksum: 'ck-by-owner',
          }, { userId: 'owner-1' })).toBe(true);

          // 管理员覆盖定义与校验和：created_by 仍是最初作者，但内容已经是管理员写的
          expect(await store.upsertWorkflowVersion({
            ...version(wfId, tenantId, 1), checksum: 'ck-by-admin',
          }, { userId: 'admin-A', isAdmin: true })).toBe(true);
          const covered = await store.getWorkflowVersion(tenantId, wfId, 1);
          expect(covered?.createdBy).toBe('owner-1');
          expect(covered?.lastModifiedBy).toBe('admin-A');
          expect(covered?.checksum).toBe('ck-by-admin');

          // 管理员提交审核后不得自审自发：最后修改者就是它自己
          expect(await store.submitWorkflowVersionForReview(tenantId, wfId, 1, { userId: 'admin-A', isAdmin: true })).toBe(true);
          expect(await store.rejectWorkflowVersion(
            tenantId, wfId, 1, { reviewer: 'admin-A', comment: '自审', at: T1 }, { userId: 'admin-A', isAdmin: true },
          )).toBe(false);
          expect(await store.publishWorkflowVersion(
            tenantId, wfId, 1, { reviewer: 'admin-A', at: T1 }, { userId: 'admin-A', isAdmin: true },
          )).toBe(false);
          expect((await store.getWorkflowVersion(tenantId, wfId, 1))?.status).toBe('in_review');

          // 第三方管理员才能审核发布，且审核人取 actor
          expect(await store.publishWorkflowVersion(
            tenantId, wfId, 1, { reviewer: 'admin-B', at: T2 }, { userId: 'admin-B', isAdmin: true },
          )).toBe(true);
          expect((await store.getWorkflowVersion(tenantId, wfId, 1))?.reviewedBy).toBe('admin-B');
        });

        it('反向绕过同样被拒：原审核人覆盖内容后不能再自审', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'tenant' as const,
          })).toBe(true);
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 1), { userId: 'admin-A', isAdmin: true })).toBe(true);
          // admin-A 是作者；owner-1 覆盖内容后，admin-A 仍不能自审
          expect(await store.upsertWorkflowVersion({
            ...version(wfId, tenantId, 1), checksum: 'ck-by-owner',
          }, { userId: 'owner-1' })).toBe(true);
          expect(await store.submitWorkflowVersionForReview(tenantId, wfId, 1, { userId: 'owner-1' })).toBe(true);
          expect(await store.publishWorkflowVersion(
            tenantId, wfId, 1, { reviewer: 'admin-A', at: T1 }, { userId: 'admin-A', isAdmin: true },
          )).toBe(false);
          expect((await store.getWorkflowVersion(tenantId, wfId, 1))?.status).toBe('in_review');
          // 第三方管理员可以发布
          expect(await store.publishWorkflowVersion(
            tenantId, wfId, 1, { reviewer: 'admin-B', at: T2 }, { userId: 'admin-B', isAdmin: true },
          )).toBe(true);
        });

        it('省略 deptId 更新时保留库中原值，部门可见的工作流不会凭空消失', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'department' as const, deptId: 'dept-a',
          }, { userId: 'owner-1', departmentIds: ['dept-a'] })).toBe(true);
          expect((await store.getWorkflow(tenantId, wfId))?.deptId).toBe('dept-a');

          // 管理员只改名字、不带 deptId：部门归属必须保留
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'department' as const, name: '改名', updatedAt: T1,
          }, { userId: 'admin-A', isAdmin: true })).toBe(true);
          expect((await store.getWorkflow(tenantId, wfId))?.deptId).toBe('dept-a');
          // 所有者与部门成员都仍然可见
          expect(await store.getWorkflow(tenantId, wfId, { userId: 'owner-1', departmentIds: ['dept-a'] })).toBeDefined();
          expect(await store.getWorkflow(tenantId, wfId, { userId: 'member-1', departmentIds: ['dept-a'] })).toBeDefined();
          expect(await store.listWorkflows({ tenantId, actor: { userId: 'owner-1', departmentIds: ['dept-a'] } }))
            .toHaveLength(1);
        });

        it('多部门所有者更新时不选部门也能改，新建时仍必须显式选择', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-2'), visibility: 'department' as const, deptId: 'dept-a',
          }, { userId: 'owner-2', departmentIds: ['dept-a', 'dept-b'] })).toBe(true);

          // 更新时省略 deptId：不再整条拒绝，保留原部门
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-2'), visibility: 'department' as const, name: '改名', updatedAt: T1,
          }, { userId: 'owner-2', departmentIds: ['dept-a', 'dept-b'] })).toBe(true);
          const updated = await store.getWorkflow(tenantId, wfId);
          expect(updated?.name).toBe('改名');
          expect(updated?.deptId).toBe('dept-a');

          // 新建时多部门用户仍必须显式选择部门
          expect(await store.upsertWorkflow({
            ...workflow(`wf-${randomUUID()}`, tenantId, 'owner-2'), visibility: 'department' as const,
          }, { userId: 'owner-2', departmentIds: ['dept-a', 'dept-b'] })).toBe(false);
        });

        it('软删除是终态：删除后不能再送审与发布', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'tenant' as const,
          })).toBe(true);
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 1))).toBe(true);
          expect(await store.deleteWorkflow(tenantId, wfId, T1)).toBe(true);

          expect(await store.submitWorkflowVersionForReview(tenantId, wfId, 1)).toBe(false);
          expect(await store.submitWorkflowVersionForReview(tenantId, wfId, 1, { userId: 'owner-1' })).toBe(false);
          expect(await store.publishWorkflowVersion(tenantId, wfId, 1, { reviewer: 'admin-1', at: T1 })).toBe(false);
          expect(await store.publishWorkflowVersion(
            tenantId, wfId, 1, { reviewer: 'admin-1', at: T1 }, { userId: 'admin-1', isAdmin: true },
          )).toBe(false);
          expect((await store.getWorkflowVersion(tenantId, wfId, 1))?.status).toBe('draft');
        });

        it('草稿直发不写审核留痕：reviewed_by 只能来自真正的审核', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'admin-2'), visibility: 'tenant' as const,
          }, { userId: 'admin-2', isAdmin: true })).toBe(true);
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 1), { userId: 'admin-2', isAdmin: true })).toBe(true);
          expect(await store.publishWorkflowVersion(
            tenantId, wfId, 1, { reviewer: 'admin-2', at: T1 }, { userId: 'admin-2', isAdmin: true },
          )).toBe(true);
          const published = await store.getWorkflowVersion(tenantId, wfId, 1);
          expect(published?.status).toBe('published');
          expect(published?.publishedBy).toBe('admin-2');
          // 直发没有审核人：不得伪造「已审核」留痕
          expect(published?.reviewedBy).toBeUndefined();
          expect(published?.reviewedAt).toBeUndefined();
        });

        it('版本号必须单调递增：不能用客户端指定版本号插空或回退', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'tenant' as const,
          })).toBe(true);
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 5))).toBe(true);
          // 回退到更小的版本号：拒绝
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 1))).toBe(false);
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 3))).toBe(false);
          // 更大的版本号：允许
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 6))).toBe(true);
          // 更新已存在的版本号：允许（这是改草稿，不是新版本）
          expect(await store.upsertWorkflowVersion({
            ...version(wfId, tenantId, 5), checksum: 'ck-fixed',
          })).toBe(true);
          expect((await store.getWorkflowVersion(tenantId, wfId, 5))?.checksum).toBe('ck-fixed');
        });

        it('版本指针由存储层维护：当前草稿与已发布版本号自动跟进且只增不减', async () => {
          const tenantId = `tenant-${randomUUID()}`;
          const wfId = `wf-${randomUUID()}`;
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'tenant' as const,
          })).toBe(true);
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 1))).toBe(true);
          expect((await store.getWorkflow(tenantId, wfId))?.currentDraftVersion).toBe(1);
          expect(await store.upsertWorkflowVersion(version(wfId, tenantId, 2))).toBe(true);
          expect((await store.getWorkflow(tenantId, wfId))?.currentDraftVersion).toBe(2);

          expect(await store.submitWorkflowVersionForReview(tenantId, wfId, 2)).toBe(true);
          expect(await store.publishWorkflowVersion(tenantId, wfId, 2, { reviewer: 'admin-1', at: T1 })).toBe(true);
          expect((await store.getWorkflow(tenantId, wfId))?.latestPublishedVersion).toBe(2);

          // 指针只增不减：调用方传更小的值不会把指针写回去
          expect(await store.upsertWorkflow({
            ...workflow(wfId, tenantId, 'owner-1'), visibility: 'tenant' as const,
            currentDraftVersion: 1, updatedAt: T2,
          })).toBe(true);
          expect((await store.getWorkflow(tenantId, wfId))?.currentDraftVersion).toBe(2);
          expect((await store.getWorkflow(tenantId, wfId))?.latestPublishedVersion).toBe(2);
        });
  });
}

registerContract({
  name: 'SQLite',
  available: true,
  create: () => new SqliteMetadataStore(':memory:'),
});

const postgresUrl = process.env.WORKFLOW_TEST_POSTGRES_URL;
registerContract({
  name: 'PostgreSQL',
  available: Boolean(postgresUrl),
  create: async () => {
    // 共享库里会残留历史数据（platform 模板对所有租户可见），
    // 每个用例前先清掉工作流表，保证与 SQLite 的 :memory: 同等隔离。
    await dropWorkflowTables(postgresUrl!);
    return new PgMetadataStore(postgresUrl!);
  },
});

/** 早期 A2 表结构：没有 missing_refs、llm_calls 和 tool_calls 列。 */
const LEGACY_RUNS_DDL = {
  sqlite: `
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
      initiator_id TEXT NOT NULL, identity_snapshot TEXT NOT NULL, input_json TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('debug','published')),
      status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled','interrupted')),
      definition_snapshot TEXT, definition_checksum TEXT NOT NULL, trace_id TEXT NOT NULL,
      idempotency_key TEXT, lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
      error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, started_at TEXT,
      ended_at TEXT, updated_at TEXT NOT NULL, expires_at TEXT,
      CHECK ((mode = 'debug' AND definition_snapshot IS NOT NULL) OR (mode = 'published' AND definition_snapshot IS NULL))
    )`,
  postgres: `
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
      initiator_id TEXT NOT NULL, identity_snapshot JSONB NOT NULL, input_json JSONB NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('debug','published')),
      status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled','interrupted')),
      definition_snapshot JSONB, definition_checksum TEXT NOT NULL, trace_id TEXT NOT NULL,
      idempotency_key TEXT, lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
      error_code TEXT, error_message TEXT, created_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ,
      CHECK ((mode = 'debug' AND definition_snapshot IS NOT NULL) OR (mode = 'published' AND definition_snapshot IS NULL))
    )`,
};

const LEGACY_STEPS_DDL = {
  sqlite: `
    CREATE TABLE workflow_step_runs (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_approval','succeeded','failed','skipped')),
      input_json TEXT, output_json TEXT, error_code TEXT, error_message TEXT,
      approval_id TEXT, idempotency_key TEXT, side_effect_unknown INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (run_id, node_id)
    )`,
  postgres: `
    CREATE TABLE workflow_step_runs (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_approval','succeeded','failed','skipped')),
      input_json JSONB, output_json JSONB, error_code TEXT, error_message TEXT,
      approval_id TEXT, idempotency_key TEXT, side_effect_unknown BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (run_id, node_id)
    )`,
};

/** 老库（补列之前）的工作流表结构：没有 dept_id 列，可见范围判定依赖它。 */
const LEGACY_WORKFLOWS_DDL = {
  sqlite: `
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('private','department','tenant')),
      current_draft_version INTEGER, latest_published_version INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    )`,
  postgres: `
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('private','department','tenant')),
      current_draft_version INTEGER, latest_published_version INTEGER,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ
    )`,
};

/** 老库补列：早期 A2 表必须能被 init() 补列并正常写入。 */
describe('老库补列迁移', () => {
  async function assertLegacyMigration(store: MetadataStore): Promise<void> {
    const tenantId = `tenant-${randomUUID()}`;
    const seeded = await seed(store, tenantId);
    const runRecord = run(`run-${randomUUID()}`, seeded.workflow);
    expect(await store.insertWorkflowRun(runRecord)).toBe(true);
    expect(await store.upsertWorkflowStepRun(tenantId, {
      id: `step-${randomUUID()}`,
      runId: runRecord.id,
      nodeId: 'notify',
      attempt: 1,
      status: 'succeeded',
      output: { text: '结果' },
      sideEffectUnknown: false,
      llmCalls: 2,
      toolCalls: 1,
      missingRefs: ['input.note'],
      createdAt: T0,
      updatedAt: T1,
    })).toBe(true);
    expect(await store.getWorkflowStepRun(tenantId, runRecord.id, 'notify')).toMatchObject({
      llmCalls: 2,
      toolCalls: 1,
      missingRefs: ['input.note'],
    });
    const started = await store.transitionWorkflowRun(tenantId, runRecord.id, 'queued', 0, {
      status: 'running', updatedAt: T1, missingRefs: ['input.note'],
    });
    expect(started?.missingRefs).toEqual(['input.note']);
    // 老库补列后必须能写 dept_id：可见范围判定依赖它
    const deptRecord = {
      ...workflow(`wf-${randomUUID()}`, tenantId),
      visibility: 'department' as const,
      deptId: 'dept-a',
    };
    expect(await store.upsertWorkflow(deptRecord)).toBe(true);
    expect((await store.getWorkflow(tenantId, deptRecord.id))?.deptId).toBe('dept-a');
  }

  it('SQLite：init() 补列后可以正常写入缺失引用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eap-workflow-migrate-'));
    const file = join(dir, 'legacy.db');
    const legacy = new Database(file);
    legacy.exec(LEGACY_RUNS_DDL.sqlite);
    legacy.exec(LEGACY_STEPS_DDL.sqlite);
    legacy.exec(LEGACY_WORKFLOWS_DDL.sqlite);
    legacy.close();

    const store = new SqliteMetadataStore(file);
    try {
      await store.init();
      await assertLegacyMigration(store);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PostgreSQL：init() 补列后可以正常写入缺失引用', async () => {
    if (!postgresUrl) return; // 未提供专用测试库时跳过。
    const client = new Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query('DROP TABLE IF EXISTS workflow_step_runs, workflow_runs, workflows CASCADE');
      await client.query(LEGACY_RUNS_DDL.postgres);
      await client.query(LEGACY_STEPS_DDL.postgres);
      await client.query(LEGACY_WORKFLOWS_DDL.postgres);
    } finally {
      await client.end();
    }
    const store = new PgMetadataStore(postgresUrl);
    try {
      await store.init();
      await assertLegacyMigration(store);
    } finally {
      await store.close();
    }
  });

  it('PostgreSQL：多副本并发及重复 init() 均成功，幂等约束仍然有效', async () => {
    if (!postgresUrl) return;
    await dropWorkflowTables(postgresUrl);
    const first = new PgMetadataStore(postgresUrl);
    const second = new PgMetadataStore(postgresUrl);
    try {
      await Promise.all([first.init(), second.init()]);
      await Promise.all([first.init(), second.init()]);
      const tenantId = `tenant-${randomUUID()}`;
      const seeded = await seed(first, tenantId);
      const original = run(`run-${randomUUID()}`, seeded.workflow);
      original.idempotencyKey = 'concurrent-init-key';
      expect(await first.insertWorkflowRun(original)).toBe(true);
      expect(await second.insertWorkflowRun({
        ...original,
        id: `run-${randomUUID()}`,
        traceId: 'another-trace',
      })).toBe(false);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await dropWorkflowTables(postgresUrl);
    }
  });

  it('PostgreSQL：幂等唯一索引建不上时 init() 必须报错，不能静默吞掉 23505', async () => {
    if (!postgresUrl) return; // 未提供专用测试库时跳过。
    const client = new Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query('DROP TABLE IF EXISTS workflow_runs CASCADE');
      await client.query('DROP INDEX IF EXISTS idx_workflow_run_idempotency');
      await client.query(LEGACY_RUNS_DDL.postgres);
      // 存量数据里出现重复幂等键：唯一索引必然建不上（SQLSTATE 23505）
      for (const id of ['dup-1', 'dup-2']) {
        await client.query(
          `INSERT INTO workflow_runs (id,tenant_id,workflow_id,workflow_version,initiator_id,identity_snapshot,
             input_json,mode,status,definition_snapshot,definition_checksum,trace_id,idempotency_key,lock_version,
             created_at,updated_at)
           VALUES ($1,'t1','wf-1',1,'u-1','{}'::jsonb,'{}'::jsonb,'published','queued',NULL,'ck','tr','same-key',0,now(),now())`,
          [id],
        );
      }
    } finally {
      await client.end();
    }
    const store = new PgMetadataStore(postgresUrl);
    try {
      // 必须让运维看到「先清理重复数据」，而不是带着缺失的唯一索引继续跑
      await expect(store.init()).rejects.toThrow();
    } finally {
      await store.close();
      const cleanup = new Client({ connectionString: postgresUrl });
      await cleanup.connect();
      try {
        await cleanup.query('DROP TABLE IF EXISTS workflow_runs CASCADE');
        await cleanup.query('DROP INDEX IF EXISTS idx_workflow_run_idempotency');
      } finally {
        await cleanup.end();
      }
    }
  });
});
