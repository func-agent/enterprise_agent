/**
 * SHA-256 纯 JS 实现单测 —— PKCE code_challenge 的兜底摘要。
 *
 * 背景：控制台通过公网明文 HTTP（http://<公网IP>:5173）访问时不是安全上下文，
 * `crypto.subtle` 不可用，PKCE 会直接抛 TypeError 导致登录按钮点了没反应。
 * 兜底实现必须与原生 `crypto.subtle.digest('SHA-256', ...)` 逐字节一致，
 * 否则 Keycloak 校验 code_challenge 时会判定不匹配、授权码交换失败。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../apps/webui/src/sha256';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('SHA-256 纯 JS 实现', () => {
  it('匹配 FIPS 180-4 标准测试向量', () => {
    // 三个经典向量
    expect(hex(sha256(utf8('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('与 Node 原生实现逐字节一致（含 55/56/64 字节边界）', () => {
    const cases = [
      '',
      'a',
      'abc',
      'x'.repeat(54),
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(63),
      'x'.repeat(64),
      'x'.repeat(65),
      'x'.repeat(1000),
    ];
    for (const input of cases) {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      expect(hex(sha256(utf8(input))), `输入长度 ${input.length}`).toBe(expected);
    }
  });

  it('支持中文等多字节字符（UTF-8 编码后计算）', () => {
    const input = '企业级 AI Agent 平台';
    const expected = createHash('sha256').update(input, 'utf8').digest('hex');
    expect(hex(sha256(utf8(input)))).toBe(expected);
  });

  it('输出长度恒为 32 字节', () => {
    for (const len of [0, 1, 31, 32, 63, 64, 200]) {
      expect(sha256(new Uint8Array(len)).length).toBe(32);
    }
  });
});
