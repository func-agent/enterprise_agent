/**
 * MCP Hub 入口 —— 启动三个 MCP Server（文档检索 / ChatBI / 业务系统）。
 *
 * 生产形态由 RAGFlow / DB-GPT / 业务 MCP 容器承担（见 deploy/compose）；
 * 本实现提供功能等价、接口一致的本地服务，用于 POC 与端到端联调。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { config, createLogger } from '@eap/platform-core';
import { startMcpHttpServer } from './server-base.js';
import { createKnowledgeTools } from './servers/knowledge.js';
import { createChatbiTools } from './servers/chatbi.js';
import { createBusinessTools } from './servers/business.js';
import { InfinityClient } from './retrieval/infinity.js';
import { TeiClient } from './retrieval/tei.js';

const log = createLogger('mcp-hub');

const DATA_DIR = process.env.EAP_DATA_DIR ?? './data';
const CHATBI_DB = process.env.CHATBI_DB_PATH ?? `${DATA_DIR}/chatbi.db`;

const REGIONS = ['华东', '华北', '华南', '西南'];
const DEPTS = ['直销部', '渠道部', '大客户部'];
const CUSTOMERS = ['星海科技', '云图信息', '天工制造', '恒信物流', '锦程贸易', '锐思医疗'];
const STATUSES = ['paid', 'paid', 'paid', 'paid', 'pending', 'refunded'];

/** 构造 ChatBI 演示数据集 */
export function seedChatbiDatabase(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  const hasOrders = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (hasOrders && process.env.CHATBI_RESET_DEMO !== 'true') {
    db.close();
    log.info('ChatBI 数据库已存在，保留现有数据', { dbPath });
    return;
  }
  db.exec(`
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS invoices;
    DROP TABLE IF EXISTS payments;
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_date TEXT NOT NULL,
      region TEXT NOT NULL,
      dept TEXT NOT NULL,
      customer TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_date TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_date TEXT NOT NULL,
      invoice_id INTEGER NOT NULL,
      amount REAL NOT NULL
    );
  `);

  const insertOrder = db.prepare(
    'INSERT INTO orders (order_date, region, dept, customer, amount, status) VALUES (?,?,?,?,?,?)',
  );
  const insertInvoice = db.prepare(
    'INSERT INTO invoices (invoice_date, order_id, amount, status) VALUES (?,?,?,?)',
  );
  const insertPayment = db.prepare(
    'INSERT INTO payments (payment_date, invoice_id, amount) VALUES (?,?,?)',
  );

  // 确定性伪随机，保证结果可复现
  let seed = 20241118;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const tx = db.transaction(() => {
    for (let m = 0; m < 12; m++) {
      const month = String(m + 1).padStart(2, '0');
      for (let i = 0; i < 22; i++) {
        const day = String(1 + Math.floor(rnd() * 28)).padStart(2, '0');
        const date = `2024-${month}-${day}`;
        const region = REGIONS[Math.floor(rnd() * REGIONS.length)];
        const dept = DEPTS[Math.floor(rnd() * DEPTS.length)];
        const customer = CUSTOMERS[Math.floor(rnd() * CUSTOMERS.length)];
        const amount = Math.round((8000 + rnd() * 240000) * 100) / 100;
        const status = STATUSES[Math.floor(rnd() * STATUSES.length)];
        const info = insertOrder.run(date, region, dept, customer, amount, status);
        const orderId = Number(info.lastInsertRowid);

        if (status !== 'refunded' && rnd() > 0.25) {
          const invDate = `2024-${month}-${String(Math.min(28, Number(day) + 3)).padStart(2, '0')}`;
          const inv = insertInvoice.run(invDate, orderId, Math.round(amount * 1.13 * 100) / 100, 'issued');
          if (rnd() > 0.3) {
            const payDate = `2024-${month}-${String(Math.min(28, Number(day) + 8)).padStart(2, '0')}`;
            insertPayment.run(payDate, Number(inv.lastInsertRowid), Math.round(amount * 1.13 * 100) / 100);
          }
        }
      }
    }
  });
  tx();
  db.close();
  log.info('ChatBI 演示数据集已生成', { dbPath });
}

async function main() {
  const dataDir = process.env.EAP_DATA_DIR ?? './data';
  mkdirSync(dataDir, { recursive: true });

  // ChatBI 演示库
  const chatbiDb = process.env.CHATBI_DB_PATH ?? `${dataDir}/chatbi.db`;
  seedChatbiDatabase(chatbiDb);

  // 知识库元数据存储 —— 必须与网关用同一份（STORE_KIND 切换 PG / SQLite），
  // 否则 MCP 侧看到的知识库与网关侧不一致。
  const { SqliteMetadataStore, PgMetadataStore, config } = await import('@eap/platform-core');
  type KnowledgeDoc = import('@eap/platform-core').KnowledgeDoc;
  const store =
    config.store.kind === 'postgres' && config.store.postgresUrl
      ? new PgMetadataStore(config.store.postgresUrl)
      : new SqliteMetadataStore(process.env.STORE_SQLITE_PATH ?? `${dataDir}/platform.db`);
  await store.init();

  // —— Infinity 检索引擎 + TEI 本地嵌入（可选，见 4.2）
  //     未配置或不可用时，knowledge 自动回退本地 BM25，不影响可用性
  const infinityUrl = process.env.INFINITY_BASE_URL ?? '';
  type SyncResult = { synced: number; embedded: number; total: number; tenants: number };
  /** 全量同步函数 —— init() 之前声明，供 InfinityClient 重建回调复用 */
  let syncRef: (() => Promise<SyncResult>) | undefined;
  let rebuiltResult: SyncResult | undefined;
  const infinity = infinityUrl
    ? new InfinityClient({
        baseUrl: infinityUrl,
        database: process.env.INFINITY_DATABASE ?? 'eap_kb',
        table: process.env.INFINITY_TABLE ?? 'eap_knowledge_chunks',
        dimensions: Number(process.env.TEI_EMBED_DIMENSIONS ?? 0),
        timeoutMs: Number(process.env.INFINITY_TIMEOUT_MS ?? 30_000),
        // 表被重建（DELETE + CREATE）会清空全部数据；回灌不完整时必须让重建失败，
        // 由 InfinityClient 将引擎标记为不可用，检索随后回退到实时主库。
        onRebuild: async () => {
          const result = await syncRef?.();
          if (!result) throw new Error('知识库同步函数尚未初始化');
          if (result.synced !== result.total) {
            throw new Error(`知识库重建后回灌不完整：${result.synced}/${result.total}`);
          }
          rebuiltResult = result;
        },
      })
    : undefined;
  const teiBase = process.env.TEI_BASE_URL ?? '';
  const tei = teiBase
    ? new TeiClient({
        baseUrl: teiBase,
        queryPrefix: process.env.TEI_QUERY_PREFIX ?? '',
        passagePrefix: process.env.TEI_PASSAGE_PREFIX ?? '',
      })
    : undefined;

  if (infinity) {
    const syncOnce = async (): Promise<SyncResult> => {
      // 重建可能发生在运行期，必须读取当前主库，不能复用启动时的快照。
      const tenants = await store.listTenants();
      const docs: KnowledgeDoc[] = [];
      for (const t of tenants) {
        docs.push(...(await store.listKnowledgeDocs(t.id)));
      }
      for (const t of tenants) {
        await infinity.deleteByFilter(`tenant_id = '${t.id.replace(/'/g, "''")}'`);
      }
      let synced = 0;
      let embedded = 0;
      for (const d of docs) {
        let embedding: number[] | undefined;
        if (tei && infinity.capabilities.vector) {
          try {
            // 文档侧用 passage 前缀（e5 / bge-m3 约定），与查询侧区分
            const passagePrefix = process.env.TEI_PASSAGE_PREFIX ?? '';
            const text = `${passagePrefix}${d.title}\n${d.content}`;
            embedding = (await tei.embed([text]))[0];
            if (embedding?.length) embedded++;
          } catch {
            embedding = undefined;
          }
        }
        const done = await infinity.upsert({
          docId: d.id,
          tenantId: d.tenantId,
          deptId: d.deptId,
          sensitivity: d.sensitivity,
          title: d.title,
          content: d.content,
          updatedAt: d.updatedAt,
          embedding,
        });
        if (done) synced++;
      }
      return { synced, embedded, total: docs.length, tenants: tenants.length };
    };
    syncRef = syncOnce;

    // init 放在 syncOnce 之后 —— init 内部若因维度不符重建表，
    // 重建回调会立刻调用 syncOnce 把当前主库数据灌回来。
    const ok = await infinity.init();
    if (ok) {
      let result = rebuiltResult ?? (await syncOnce());
      if (result.synced < result.total) {
        log.warn('知识库同步不完整，重建检索表后重试', { synced: result.synced, total: result.total });
        rebuiltResult = undefined;
        if (await infinity.recreateTable()) {
          result = rebuiltResult ?? (await syncOnce());
        }
      }

      log.info('知识库已同步至 Infinity', {
        tenants: result.tenants,
        total: result.total,
        synced: result.synced,
        embedded: result.embedded,
        available: infinity.isAvailable,
        ...infinity.capabilities,
      });
    }
  }

  await startMcpHttpServer({
    name: 'eap-knowledge',
    version: '1.0.0',
    port: Number(process.env.MCP_KNOWLEDGE_PORT ?? 8091),
    tools: createKnowledgeTools(store, { infinity, tei }),
  });

  await startMcpHttpServer({
    name: 'eap-chatbi',
    version: '1.0.0',
    port: Number(process.env.MCP_CHATBI_PORT ?? 8092),
    tools: createChatbiTools(chatbiDb),
  });

  await startMcpHttpServer({
    name: 'eap-business',
    version: '1.0.0',
    port: Number(process.env.MCP_BUSINESS_PORT ?? 8093),
    tools: createBusinessTools(),
  });

  log.info('MCP Hub 全部就绪', { dataDir });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error('MCP Hub 启动失败', { error: String(err?.stack ?? err) });
    process.exit(1);
  });
}
