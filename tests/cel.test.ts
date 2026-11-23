/**
 * CEL 表达式引擎测试 —— 策略引擎的表达式底座（见 4.3 Cedar/CEL 策略）。
 */
import { describe, expect, it } from 'vitest';
import { CelEngine } from '../packages/gateway/src/policy/cel.js';

const cel = new CelEngine();

const ctx = {
  principal: {
    tenant: 't-default',
    tenantId: 't-default',
    user: 'u-1',
    userId: 'u-1',
    role: 'employee',
    dept: 'dept-east',
    deptId: 'dept-east',
    sensitivity: 'internal',
    scopes: ['chat', 'knowledge.read'],
  },
  request: {
    service: 'llm',
    operation: 'chat',
    model: 'smart-model',
    tool: 'knowledge.search',
    server: 'knowledge',
  },
  resource: { model: 'smart-model', tool: 'knowledge.search', server: 'knowledge' },
};

describe('CEL 字面量与路径访问', () => {
  it('解析字符串/数字/布尔/null', () => {
    expect(cel.eval('1 + 2', ctx)).toBe(3);
    expect(cel.eval('"a" + "b"', ctx)).toBe('ab');
    expect(cel.eval('true && false', ctx)).toBe(false);
    expect(cel.eval('null == null', ctx)).toBe(true);
  });

  it('读取嵌套路径', () => {
    expect(cel.eval('principal.tenant', ctx)).toBe('t-default');
    expect(cel.eval('request.model', ctx)).toBe('smart-model');
    expect(cel.eval('principal.deptId', ctx)).toBe('dept-east');
  });

  it('读取数组下标', () => {
    expect(cel.eval('principal.scopes[0]', ctx)).toBe('chat');
    expect(cel.eval('principal.scopes[1]', ctx)).toBe('knowledge.read');
  });
});

describe('CEL 逻辑与比较', () => {
  it('&& / || 短路', () => {
    expect(cel.evalBool("principal.role == 'employee' && request.service == 'llm'", ctx)).toBe(true);
    expect(cel.evalBool("principal.role == 'admin' || request.service == 'llm'", ctx)).toBe(true);
    expect(cel.evalBool("principal.role == 'admin' && request.service == 'llm'", ctx)).toBe(false);
  });

  it('! 取反', () => {
    expect(cel.evalBool("!(principal.sensitivity == 'confidential')", ctx)).toBe(true);
  });

  it('in 成员判断', () => {
    expect(cel.evalBool("'chat' in principal.scopes", ctx)).toBe(true);
    expect(cel.evalBool("'admin' in principal.scopes", ctx)).toBe(false);
    expect(cel.evalBool("'llm' in ['llm','tool']", ctx)).toBe(true);
  });

  it('三元表达式', () => {
    expect(cel.eval("principal.role == 'employee' ? 'A' : 'B'", ctx)).toBe('A');
  });

  it('数值比较', () => {
    expect(cel.evalBool('1 < 2', ctx)).toBe(true);
    expect(cel.evalBool('2 >= 2', ctx)).toBe(true);
  });
});

describe('CEL 内置函数', () => {
  it('startsWith / endsWith / contains', () => {
    expect(cel.evalBool("'knowledge.search'.startsWith('knowledge.')", ctx)).toBe(true);
    expect(cel.evalBool("'knowledge.search'.endsWith('.search')", ctx)).toBe(true);
    expect(cel.evalBool("'knowledge.search'.contains('search')", ctx)).toBe(true);
  });

  it('matches 正则', () => {
    expect(cel.evalBool("request.model.matches('^smart-.*$')", ctx)).toBe(true);
    expect(cel.evalBool("request.model.matches('^reasoning-.*$')", ctx)).toBe(false);
  });

  it('size / lower / upper', () => {
    expect(cel.eval('size(principal.scopes)', ctx)).toBe(2);
    expect(cel.eval("lower('ABC')", ctx)).toBe('abc');
    expect(cel.eval("upper('abc')", ctx)).toBe('ABC');
  });

  it('has 判断字段存在性', () => {
    expect(cel.evalBool('has(principal.role)', ctx)).toBe(true);
    expect(cel.evalBool('has(principal.missingField)', ctx)).toBe(false);
  });
});

describe('CEL 错误处理', () => {
  it('非法字符抛错', () => {
    expect(() => cel.compile('a # b')).toThrow();
  });

  it('未知函数抛错', () => {
    expect(() => cel.eval('nosuchfn(1)', ctx)).toThrow(/未知函数/);
  });
});
