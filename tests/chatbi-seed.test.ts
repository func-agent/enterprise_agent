import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { seedChatbiDatabase } from '../packages/mcp-hub/src/main.js';

describe('ChatBI 演示数据初始化', () => {
  it('服务重启保留已有数据，不重复 DROP/SEED', () => {
    const dir = mkdtempSync(join(process.cwd(), '.cache', 'chatbi-seed-'));
    const file = join(dir, 'chatbi.db');
    const previous = process.env.CHATBI_RESET_DEMO;
    delete process.env.CHATBI_RESET_DEMO;
    try {
      seedChatbiDatabase(file);
      let db = new Database(file);
      const initial = (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
      db.prepare("INSERT INTO orders (order_date, region, dept, customer, amount, status) VALUES ('2026-01-01','华东','直销部','保留数据',1,'paid')").run();
      db.close();
      seedChatbiDatabase(file);
      db = new Database(file);
      expect((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n).toBe(initial + 1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE customer='保留数据'").get()).toEqual({ n: 1 });
      db.close();
    } finally {
      if (previous === undefined) delete process.env.CHATBI_RESET_DEMO;
      else process.env.CHATBI_RESET_DEMO = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
