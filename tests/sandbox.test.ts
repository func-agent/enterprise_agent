/**
 * 只读 SQL 沙箱测试 —— 写操作必须被拒绝（见 6.2 关键配置：写操作一律禁止自动写库）。
 */
import { describe, expect, it } from 'vitest';
import { runReadOnlySql, validateReadOnly } from '../packages/mcp-hub/src/sandbox.js';

describe('SQL 语句级校验', () => {
  it('放行 SELECT', () => {
    expect(validateReadOnly('SELECT * FROM orders').ok).toBe(true);
  });

  it('放行 WITH ... SELECT', () => {
    expect(validateReadOnly('WITH t AS (SELECT 1) SELECT * FROM t').ok).toBe(true);
  });

  it('拒绝 INSERT', () => {
    const r = validateReadOnly("INSERT INTO orders VALUES (1)");
    expect(r.ok).toBe(false);
    expect(r.error).toContain('写操作');
  });

  it('拒绝 UPDATE / DELETE', () => {
    expect(validateReadOnly("UPDATE orders SET amount = 0").ok).toBe(false);
    expect(validateReadOnly("DELETE FROM orders").ok).toBe(false);
  });

  it('拒绝 DDL', () => {
    expect(validateReadOnly('DROP TABLE orders').ok).toBe(false);
    expect(validateReadOnly('ALTER TABLE orders ADD COLUMN x INT').ok).toBe(false);
    expect(validateReadOnly('CREATE TABLE t (a INT)').ok).toBe(false);
  });

  it('拒绝 PRAGMA / VACUUM', () => {
    expect(validateReadOnly('PRAGMA table_info(orders)').ok).toBe(false);
    expect(validateReadOnly('VACUUM').ok).toBe(false);
  });

  it('拒绝多语句', () => {
    expect(validateReadOnly('SELECT 1; DROP TABLE orders').ok).toBe(false);
  });

  it('字符串字面量中的分号不误判', () => {
    expect(validateReadOnly("SELECT * FROM t WHERE name = 'a;b'").ok).toBe(true);
  });

  it('拒绝空 SQL', () => {
    expect(validateReadOnly('   ').ok).toBe(false);
  });

  it('拒绝非 SELECT 开头', () => {
    expect(validateReadOnly('SHOW TABLES').ok).toBe(false);
  });
});


describe('SQL worker 资源上限', () => {
  it('调用方超大 LIMIT 也不能突破 maxRows，空结果仍返回列信息', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { default: Database } = await import('better-sqlite3');
    const dir = mkdtempSync(join(process.cwd(), '.cache', 'sandbox-test-'));
    const file = join(dir, 'test.db');
    const db = new Database(file);
    db.exec('CREATE TABLE items (id INTEGER, value TEXT)');
    for (let i = 0; i < 20; i++) db.prepare('INSERT INTO items VALUES (?, ?)').run(i, String(i));
    db.close();
    try {
      const bounded = await runReadOnlySql(file, 'SELECT * FROM items LIMIT 100000', 5000, 5);
      expect(bounded.ok).toBe(true);
      expect(bounded.rows).toHaveLength(5);
      expect(bounded.columns).toEqual(['id', 'value']);
      const empty = await runReadOnlySql(file, 'SELECT * FROM items WHERE id < 0', 5000, 5);
      expect(empty.rows).toHaveLength(0);
      expect(empty.columns).toEqual(['id', 'value']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
