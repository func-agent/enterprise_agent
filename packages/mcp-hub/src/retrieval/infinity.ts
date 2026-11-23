/**
 * Infinity 检索适配器 —— 对应 3.1 检索组件「Infinity」。
 *
 * 走官方 HTTP API（`example/http/*.sh` 给出的契约）：
 *   POST   {base}/databases/{db}                       建库
 *   POST   {base}/databases/{db}/tables/{tbl}           建表（字段类型 vector,{dim},float）
 *   POST   {base}/databases/{db}/tables/{tbl}/indexes/{n} 建全文索引
 *   POST   {base}/databases/{db}/tables/{tbl}/docs      写入文档
 *   GET    {base}/databases/{db}/tables/{tbl}/docs      检索（output / search / filter）
 *
 * 关键设计：**过滤条件下推**（见方案 5.2 最高优先级 —— 禁止全库召回后再过滤）。
 * `filter` 表达式在引擎内先裁剪候选集，再做 dense/text 召回与融合，
 * 因此不可见文档从不进入排序，天然满足「召回前过滤」。
 *
 * 能力探测：向量列 / 全文索引按可用性逐项降级，绝不假装成功。
 */
import { createLogger } from '@eap/platform-core';
import { jsonRequest } from './http-json.js';

const log = createLogger('mcp:infinity');

export interface InfinityDoc {
  docId: string;
  tenantId: string;
  deptId: string;
  sensitivity: string;
  title: string;
  content: string;
  updatedAt: string;
  /** 预计算的向量（可选；提供后走 dense 召回） */
  embedding?: number[];
}

export interface InfinityHit {
  docId: string;
  title: string;
  deptId: string;
  sensitivity: string;
  score: number;
  snippet: string;
}

export interface InfinityOptions {
  /** HTTP base，例如 http://127.0.0.1:23821 */
  baseUrl: string;
  /** 数据库名 */
  database: string;
  /** 表名 */
  table: string;
  /** 向量维度（0 = 不建向量列，只用全文检索） */
  dimensions: number;
  /** 超时（毫秒） */
  timeoutMs?: number;
  /**
   * 表被重建后的回调。
   *
   * 重建走的是 DELETE + CREATE，**表内数据会被整体清空**。
   * 调用方必须在此重新灌入（例如用 TEI 重算向量后全量同步），
   * 否则知识库向量会静默丢失 —— 平台表面正常，向量检索实际已空。
   */
  onRebuild?: () => Promise<void>;
}

export interface InfinityFilter {
  tenantId: string;
  deptId: string;
  /** 调用方密级许可的最高级别 */
  maxSensitivity: 'public' | 'internal' | 'confidential';
  /** 额外可见部门 */
  extraDepts?: string[];
}

const SENSITIVITY_RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2 };

export class InfinityClient {
  private available = false;
  private supportsVector = false;
  private supportsFullText = false;
  private initialized = false;
  /** 重建重入保护：重建 → 回调灌数据 → 写入又触发重建，会形成死循环 */
  private rebuilding = false;

  constructor(private readonly opts: InfinityOptions) {}

  get isAvailable(): boolean {
    return this.available;
  }

  get capabilities(): { vector: boolean; fullText: boolean } {
    return { vector: this.supportsVector, fullText: this.supportsFullText };
  }

  /**
   * 拼接请求 URL。
   *
   * ⚠ 不能直接用 parts.join('/') —— 传入的片段有的带前导斜杠、有的不带
   * （库名/表名是变量），拼出来会是 `/databases/db//tables/tbl`。
   * Infinity（oatpp）对此宽容，但严格路由的服务会直接 404。
   */
  private url(...parts: string[]): string {
    const path = parts
      .map((p) => p.replace(/^\/+|\/+$/g, ''))
      .filter((p) => p.length > 0)
      .join('/');
    return `${this.opts.baseUrl.replace(/\/+$/, '')}/${path}`;
  }

  /** 统一的 JSON 请求（GET 也能带 body —— Infinity 检索接口即如此） */
  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<any> {
    const res = await jsonRequest({
      method,
      url,
      body,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
    });
    if (!res.ok) {
      const detail =
        res.body?.error_msg ?? res.body?.error ?? res.text?.slice(0, 300) ?? '';
      throw new Error(`HTTP ${res.status}: ${String(detail)}`);
    }
    return res.body ?? {};
  }

  /** 读取表里 embedding 列的**实际**维度（表不存在或无向量列时返回 undefined） */
  private async currentDimension(): Promise<number | undefined> {
    try {
      const res = await this.request(
        'GET',
        this.url('/databases', this.opts.database, '/tables', this.opts.table, '/columns'),
      );
      const cols = (res?.columns ?? []) as { name?: string; type?: string }[];
      const col = cols.find((c) => c?.name === 'embedding');
      if (!col) return undefined;
      const m = /Embedding\(\s*float\s*,\s*(\d+)\s*\)/i.exec(String(col.type ?? ''));
      return m ? Number(m[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 建库 + 建表 + 建索引；失败时保持 unavailable（调用方回退本地 BM25） */
  async init(): Promise<boolean> {
    if (this.initialized) return this.available;
    this.initialized = true;
    const { database, table, dimensions } = this.opts;
    try {
      // 1) 建库
      await this.request('POST', this.url('/databases', database), { create_option: 'ignore_if_exists' });

      // 2) 建表 —— 先带向量列，失败则退化为纯文本表
      const baseFields = [
        { name: 'doc_id', type: 'varchar' },
        { name: 'tenant_id', type: 'varchar' },
        { name: 'dept_id', type: 'varchar' },
        { name: 'sensitivity', type: 'varchar' },
        { name: 'title', type: 'varchar' },
        { name: 'content', type: 'varchar' },
        { name: 'updated_at', type: 'varchar' },
      ];
      if (dimensions > 0) {
        try {
          await this.request('POST', this.url('/databases', database, '/tables', table), {
            create_option: 'ignore_if_exists',
            fields: [...baseFields, { name: 'embedding', type: `vector,${dimensions},float` }],
          });
          this.supportsVector = true;
        } catch (err: any) {
          log.warn('Infinity 向量列创建失败，退化为全文检索', { error: err?.message });
        }
      }
      if (!this.supportsVector) {
        await this.request('POST', this.url('/databases', database, '/tables', table), {
          create_option: 'ignore_if_exists',
          fields: baseFields,
        });
      }

      // 2.1) 向量列维度自愈
      //
      // ⚠ 这里必须显式校验，不能依赖建表语句。
      // Infinity 的 `create_option: ignore_if_exists` 对**已存在的表**不会纠正
      // 列类型 —— 实测：先以 vector,4,float 建表，再以 vector,384,float 同名
      // 建表，列类型仍停在 Embedding(float,4)。
      // 于是只要表是旧维度建出来的，之后每次 dense 检索都会报
      // "Query embedding with dimension: 384 which doesn't not matched with ..."，
      // 而 search() 会吞掉异常返回 []，knowledge 工具**静默降级**成本地 BM25，
      // 平台表面上一切正常，向量检索其实早就不工作了。
      if (this.supportsVector) {
        const actual = await this.currentDimension();
        if (actual !== undefined && actual !== dimensions) {
          log.warn('Infinity 向量列维度与配置不一致，重建表', { actual, want: dimensions });
          if (!(await this.recreateTable())) {
            throw new Error('Infinity 表重建或数据回灌失败');
          }
        }
      }

      // 3) 全文索引（BM25）—— 失败不影响向量检索
      try {
        await this.request(
          'POST',
          this.url('/databases', database, '/tables', table, '/indexes', 'eap_fulltext'),
          { fields: ['content'], index: { type: 'fulltext' }, create_option: 'ignore_if_exists' },
        );
        this.supportsFullText = true;
      } catch (err: any) {
        log.warn('Infinity 全文索引创建失败，仅启用向量检索', { error: err?.message });
      }

      this.available = true;
      log.info('Infinity 已就绪', { database, table, ...this.capabilities });
    } catch (err: any) {
      this.available = false;
      log.warn('Infinity 不可用，回退本地 BM25 检索', { error: err?.message ?? String(err) });
    }
    return this.available;
  }

  /**
   * 按过滤表达式删除行。
   * 同步前调用，保证重复启动不会在引擎里堆出副本。
   */
  async deleteByFilter(filterExpr: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      await this.request(
        'DELETE',
        this.url('/databases', this.opts.database, '/tables', this.opts.table, '/docs'),
        { filter: filterExpr },
      );
      return true;
    } catch (err: any) {
      log.warn('Infinity 删除失败', { filter: filterExpr, error: err?.message });
      return false;
    }
  }

  /**
   * 删除并按当前配置重建表。
   * 用于维度不匹配的自愈：建表用 create_option=ignore_if_exists，
   * 若表已存在且向量列维度与当前配置不同，写入会报
   * "Expected: Embedding(float,N), but Embedding(double,M) is given"。
   *
   * ⚠ 重建是 DELETE + CREATE，**表内数据会被整体清空**。
   * 因此重建成功后必须回调 `opts.onRebuild` 让调用方重新灌数据，
   * 否则知识库向量静默丢失（检索仍能跑，但召回结果已空）。
   */
  async recreateTable(): Promise<boolean> {
    if (this.rebuilding) {
      log.warn('Infinity 重建重入已忽略（重建回调内部再次触发了重建）');
      return false;
    }
    this.rebuilding = true;
    const { database, table, dimensions } = this.opts;
    const baseFields = [
      { name: 'doc_id', type: 'varchar' },
      { name: 'tenant_id', type: 'varchar' },
      { name: 'dept_id', type: 'varchar' },
      { name: 'sensitivity', type: 'varchar' },
      { name: 'title', type: 'varchar' },
      { name: 'content', type: 'varchar' },
      { name: 'updated_at', type: 'varchar' },
    ];
    const fields =
      dimensions > 0
        ? [...baseFields, { name: 'embedding', type: `vector,${dimensions},float` }]
        : baseFields;
    try {
      await this.request('DELETE', this.url('/databases', database, '/tables', table), {
        drop_option: 'ignore_if_not_exists',
      });
      await this.request('POST', this.url('/databases', database, '/tables', table), {
        create_option: 'ignore_if_exists',
        fields,
      });
      this.supportsVector = dimensions > 0;
      try {
        await this.request(
          'POST',
          this.url('/databases', database, '/tables', table, '/indexes', 'eap_fulltext'),
          { fields: ['content'], index: { type: 'fulltext' }, create_option: 'ignore_if_exists' },
        );
        this.supportsFullText = true;
      } catch {
        this.supportsFullText = false;
      }

      // 回灌调用 upsert/deleteByFilter，因此必须先恢复可写状态。
      this.available = true;
      if (this.opts.onRebuild) await this.opts.onRebuild();
      log.info('Infinity 表已按当前维度重建', {
        table,
        dimensions,
        refilled: Boolean(this.opts.onRebuild),
      });
      return true;
    } catch (err: any) {
      this.available = false;
      log.error('Infinity 重建或数据回灌失败，回退本地 BM25 检索', { error: err?.message });
      return false;
    } finally {
      this.rebuilding = false;
    }
  }

  /** 从引擎报错里解析期望的向量维度 */
  private expectedDimension(errMsg: string): number | undefined {
    const m = /Expected:\s*Embedding\(float,\s*(\d+)\)/i.exec(errMsg);
    return m ? Number(m[1]) : undefined;
  }

  /** 写入文档（先按 doc_id 删除旧行再插入，保证幂等） */
  async upsert(doc: InfinityDoc): Promise<boolean> {
    if (!this.available) return false;
    const row: Record<string, unknown> = {
      doc_id: doc.docId,
      tenant_id: doc.tenantId,
      dept_id: doc.deptId,
      sensitivity: doc.sensitivity,
      title: doc.title,
      content: doc.content,
      updated_at: doc.updatedAt,
    };
    if (this.supportsVector && doc.embedding?.length) {
      row.embedding = doc.embedding;
    }
    try {
      await this.deleteByFilter(
        `doc_id = '${doc.docId.replace(/'/g, "''")}' and tenant_id = '${doc.tenantId.replace(/'/g, "''")}'`,
      );
      await this.insertRows([row]);
      return true;
    } catch (err: any) {
      // 维度不匹配 → 重建表后重试一次
      const message = String(err?.message ?? '');
      const expected = this.expectedDimension(message);
      // 另一类可自愈故障：表存在但**没有 embedding 列**（例如早期以 dimensions=0 建表）
      const missingColumn = /Column embedding not found/i.test(message);
      if (
        (expected !== undefined || missingColumn) &&
        this.opts.dimensions > 0 &&
        expected !== this.opts.dimensions
      ) {
        log.warn('Infinity 向量列不可用，重建表', { expected, want: this.opts.dimensions, missingColumn });
        if (await this.recreateTable()) {
          try {
            await this.insertRows([row]);
            return true;
          } catch (e2: any) {
            log.warn('Infinity 写入失败', { docId: doc.docId, error: e2?.message });
            return false;
          }
        }
      }
      log.warn('Infinity 写入失败', { docId: doc.docId, error: err?.message });
      return false;
    }
  }

  private async insertRows(rows: Record<string, unknown>[]): Promise<void> {
    await this.request(
      'POST',
      this.url('/databases', this.opts.database, '/tables', this.opts.table, '/docs'),
      rows,
    );
  }

  /**
   * 检索。
   * - `filter` 表达式在引擎内先裁剪候选集（召回前过滤，方案 5.2）
   * - `search` 数组可同时给 dense 与 text，Infinity 自行做融合排序
   */
  async search(
    query: string,
    filter: InfinityFilter,
    topK: number,
    queryVector?: number[],
  ): Promise<InfinityHit[]> {
    if (!this.available) return [];
    const { database, table } = this.opts;

    // —— 过滤表达式（全部下推，绝不在召回后过滤）
    const maxRank = SENSITIVITY_RANK[filter.maxSensitivity] ?? 1;
    const allowed = Object.entries(SENSITIVITY_RANK)
      .filter(([, r]) => r <= maxRank)
      .map(([k]) => k);
    const depts = ['all', filter.deptId, ...(filter.extraDepts ?? [])];
    const inList = (vals: string[]) => vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
    const filterExpr = [
      `tenant_id = '${filter.tenantId.replace(/'/g, "''")}'`,
      `sensitivity in (${inList(allowed)})`,
      `dept_id in (${inList(depts)})`,
    ].join(' and ');

    // —— 召回策略
    const search: unknown[] = [];
    if (this.supportsVector && queryVector?.length) {
      search.push({
        match_method: 'dense',
        fields: 'embedding',
        query_vector: queryVector,
        element_type: 'float',
        metric_type: 'cosine',
        topn: topK,
      });
    }
    if (this.supportsFullText && query.trim()) {
      search.push({
        match_method: 'text',
        fields: 'content',
        matching_text: query,
        topn: topK,
      });
    }
    if (!search.length) return [];
    // 多个 MATCH 表达式必须配一个 FUSION 表达式，否则引擎报
    // "Need FUSION expr since there are multiple MATCH ... expressions"
    if (search.length > 1) {
      search.push({ fusion_method: 'rrf', topn: topK });
    }

    const body = {
      output: ['doc_id', 'title', 'dept_id', 'sensitivity', 'content', '_score'],
      search,
      filter: filterExpr,
    };

    try {
      const res = await this.request(
        'GET',
        this.url('/databases', database, '/tables', table, '/docs'),
        body,
      );
      if (res?.error_code !== undefined && res.error_code !== 0) {
        throw new Error(`引擎返回错误 ${res.error_code}: ${res.error_msg ?? ''}`);
      }
      return parseRows(res?.output, topK);
    } catch (err: any) {
      log.warn('Infinity 检索失败，回退本地 BM25', { error: err?.message });
      return [];
    }
  }

  async close(): Promise<void> {
    this.available = false;
    this.initialized = false;
  }
}

/**
 * Infinity 返回的是列式结果：每一行是一个数组，元素是「单键对象」，
 * 形如 `[[{"doc_id":"d1"},{"title":"…"},{"SCORE":0.016}], …]`。
 *
 * 注意：融合检索（dense + text 各一路）会让同一文档在每一路各返回一次，
 * 因此这里按 doc_id 去重、保留最高分，并按分数降序输出。
 */
function parseRows(output: unknown, topK?: number): InfinityHit[] {
  if (!Array.isArray(output)) return [];
  const best = new Map<string, InfinityHit>();
  const order: string[] = [];
  for (const row of output) {
    if (!Array.isArray(row)) continue;
    const flat: Record<string, unknown> = {};
    for (const cell of row) {
      if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
        for (const [k, v] of Object.entries(cell as Record<string, unknown>)) {
          flat[k] = v;
        }
      }
    }
    const scoreRaw = flat.SCORE ?? flat._score ?? flat.score ?? 0;
    const hit: InfinityHit = {
      docId: String(flat.doc_id ?? ''),
      title: String(flat.title ?? ''),
      deptId: String(flat.dept_id ?? 'all'),
      sensitivity: String(flat.sensitivity ?? 'internal'),
      score: Number(Number(scoreRaw).toFixed(4)),
      snippet: String(flat.content ?? '').slice(0, 400),
    };
    const prev = best.get(hit.docId);
    if (!prev) {
      best.set(hit.docId, hit);
      order.push(hit.docId);
    } else if (hit.score > prev.score) {
      best.set(hit.docId, hit);
    }
  }
  const hits = order.map((id) => best.get(id)!);
  hits.sort((a, b) => b.score - a.score);
  return topK ? hits.slice(0, topK) : hits;
}
