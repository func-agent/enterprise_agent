import { describe, expect, it } from 'vitest';
import { CredentialResolver, strictEgressClassOf } from '../packages/gateway/src/llm/providers.js';

describe('Provider 安全默认值', () => {
  it('MiniMax 静态 Key 默认 x-api-key，标准 OpenAI 兼容 Provider 默认 Bearer', () => {
    const resolver = new CredentialResolver('', 'auto', []);
    expect(resolver.resolve('minimax', 'sk-test').mode).toBe('x-api-key');
    expect(resolver.resolve('openai', 'sk-test').mode).toBe('bearer');
    expect(resolver.resolve('deepseek', 'sk-test').mode).toBe('bearer');
    expect(resolver.resolve('minimax', 'mmoa-test').mode).toBe('bearer');
  });

  it('Provider 级配置可以覆盖默认鉴权方式', () => {
    const resolver = new CredentialResolver('', 'auto', [], { openai: 'x-api-key' });
    expect(resolver.resolve('openai', 'sk-test').mode).toBe('x-api-key');
  });

  it('混合本地与外部目标按外部级别执行护栏', () => {
    expect(strictEgressClassOf(['tei'])).toBe('local');
    expect(strictEgressClassOf(['ollama', 'vllm'])).toBe('local');
    expect(strictEgressClassOf(['ollama', 'openai'])).toBe('external');
    expect(strictEgressClassOf([])).toBe('external');
  });
});
