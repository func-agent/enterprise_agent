/**
 * Infinity 重建表自愈的回归守卫。
 *
 * 背景：`InfinityClient.init()` 会校验向量列的实际维度，不一致时走
 * `recreateTable()`（DELETE + CREATE）。**重建会清空表内全部数据**，
 * 所以重建成功后必须回调 `onRebuild` 让调用方重新灌数据 ——
 * 否则知识库向量静默丢失：平台不报任何错，向量检索却已经召回不到东西。
 *
 * 这里用假 Infinity 服务验证：
 *   1. 维度不符时确实重建表；
 *   2. 重建成功后 onRebuild 被调用（数据得以重新灌入）；
 *   3. 重建回调内部再触发重建时不会死循环。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { InfinityClient, type InfinityDoc } from '../packages/mcp-hub/src/retrieval/infinity.js';

describe('Infinity 重建表自愈', () => {
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;
  /** 模拟引擎里向量列的实际维度 */
  let actualDimension: number | undefined;
  /** 表是否已存在（已存在时建表请求不会纠正列类型） */
  let tableExists: boolean;
  let createCalls: number;
  let dropCalls: number;
  let rows: Record<string, unknown>[];

  const restoredDoc: InfinityDoc = {
    docId: 'restored',
    tenantId: 't-1',
    deptId: 'all',
    sensitivity: 'internal',
    title: 'restored',
    content: 'restored content',
    updatedAt: new Date().toISOString(),
    embedding: Array(384).fill(0),
  };

  beforeEach(async () => {
    actualDimension = 384;
    tableExists = true;
    createCalls = 0;
    dropCalls = 0;
    rows = [];

    const app = express();
    app.use(express.json());
    // 建库
    app.post('/databases/:db', (_req, res) => {
      res.json({ error_code: 0 });
    });
    // 建表：只有表不存在时才按请求里的维度真正建立。
    // 表已存在时 Infinity 的 create_option: ignore_if_exists **不会**纠正列类型，
    // 建表请求等于空转 —— 这正是维度错配能长期潜伏的原因。
    app.post('/databases/:db/tables/:tbl', (req, res) => {
      createCalls++;
      if (!tableExists) {
        const fields = (req.body?.fields ?? []) as { name?: string; type?: string }[];
        const emb = fields.find((f) => f?.name === 'embedding');
        const m = emb ? /vector,\s*(\d+)/i.exec(String(emb.type ?? '')) : null;
        actualDimension = m ? Number(m[1]) : undefined;
        tableExists = true;
      }
      res.json({ error_code: 0 });
    });
    app.delete('/databases/:db/tables/:tbl', (_req, res) => {
      dropCalls++;
      actualDimension = undefined;
      tableExists = false;
      rows = [];
      res.json({ error_code: 0 });
    });
    app.get('/databases/:db/tables/:tbl/columns', (_req, res) => {
      res.json({
        error_code: 0,
        columns: actualDimension === undefined
          ? [{ name: 'doc_id', type: 'Varchar' }]
          : [
              { name: 'doc_id', type: 'Varchar' },
              { name: 'embedding', type: `Embedding(float,${actualDimension})` },
            ],
      });
    });
    app.post('/databases/:db/tables/:tbl/indexes/:idx', (_req, res) => {
      res.json({ error_code: 0 });
    });
    app.delete('/databases/:db/tables/:tbl/docs', (req, res) => {
      const filter = String(req.body?.filter ?? '');
      const docId = /doc_id\s*=\s*'([^']+)'/.exec(filter)?.[1];
      const tenantId = /tenant_id\s*=\s*'([^']+)'/.exec(filter)?.[1];
      rows = rows.filter((row) =>
        (docId !== undefined && row.doc_id !== docId) ||
        (tenantId !== undefined && row.tenant_id !== tenantId) ||
        (docId === undefined && tenantId === undefined),
      );
      res.json({ error_code: 0 });
    });
    app.post('/databases/:db/tables/:tbl/docs', (req, res) => {
      const input = (Array.isArray(req.body) ? req.body : []) as Record<string, unknown>[];
      for (const row of input) {
        const embedding = row.embedding;
        if (Array.isArray(embedding) && embedding.length !== actualDimension) {
          res.status(400).json({ error_msg: `Expected: Embedding(float,${actualDimension})` });
          return;
        }
        rows = rows.filter((item) => !(item.doc_id === row.doc_id && item.tenant_id === row.tenant_id));
        rows.push(row);
      }
      res.json({ error_code: 0 });
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('维度不符时重建表并在回调内真正恢复文档', async () => {
    actualDimension = 4;
    let rebuilt = 0;
    let refilled = false;
    let client: InfinityClient;

    client = new InfinityClient({
      baseUrl,
      database: 'db',
      table: 'tbl',
      dimensions: 384,
      onRebuild: async () => {
        rebuilt++;
        refilled = await client.upsert(restoredDoc);
      },
    });

    expect(await client.init()).toBe(true);

    expect(dropCalls).toBe(1);
    expect(createCalls).toBeGreaterThan(0);
    expect(rebuilt).toBe(1);
    expect(refilled).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doc_id).toBe(restoredDoc.docId);
  });

  it('维度一致时不重建、不回调', async () => {
    actualDimension = 384;
    let rebuilt = 0;

    const client = new InfinityClient({
      baseUrl,
      database: 'db',
      table: 'tbl',
      dimensions: 384,
      onRebuild: async () => {
        rebuilt++;
      },
    });

    await client.init();

    expect(dropCalls).toBe(0);
    expect(rebuilt).toBe(0);
  });

  it('回灌失败时初始化失败并保持引擎不可用', async () => {
    actualDimension = 4;
    const client = new InfinityClient({
      baseUrl,
      database: 'db',
      table: 'tbl',
      dimensions: 384,
      onRebuild: async () => {
        throw new Error('refill failed');
      },
    });

    expect(await client.init()).toBe(false);
    expect(client.isAvailable).toBe(false);
    expect(dropCalls).toBe(1);
    expect(rows).toHaveLength(0);
  });

  it('重建回调内部再次触发重建时不会死循环', async () => {
    actualDimension = 4;
    let rebuilt = 0;
    let nested = false;

    const client = new InfinityClient({
      baseUrl,
      database: 'db',
      table: 'tbl',
      dimensions: 384,
      onRebuild: async () => {
        rebuilt++;
        if (!nested) {
          nested = true;
          // 模拟：灌数据时又发现维度不对，再次请求重建
          await client.recreateTable();
        }
      },
    });

    await client.init();

    expect(rebuilt).toBe(1);
    // 外层一次 + 内层被重入保护挡下的一次尝试
    expect(dropCalls).toBe(1);
  });
});
