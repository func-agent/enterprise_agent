import { describe, expect, it } from 'vitest';
import { config } from '../packages/platform-core/src/config.js';
import { DEFAULT_VIRTUAL_MODELS } from '../packages/gateway/src/llm/router.js';

describe('默认虚拟模型定义', () => {
  it('虚拟模型名唯一', () => {
    const names = DEFAULT_VIRTUAL_MODELS.map((model) => model.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('minimax 只在 MiniMax 内降级', () => {
    const model = DEFAULT_VIRTUAL_MODELS.find((item) => item.name === 'minimax');
    if (!model) throw new Error('缺少 minimax 虚拟模型');
    expect(model.targets.map((target) => target.provider)).toEqual(['minimax', 'minimax']);
    expect(model.targets.map((target) => target.model)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    expect(model.targets.map((target) => target.role)).toEqual(['primary', 'fallback']);
  });

  it('Embedding 描述使用实际加载的 TEI 模型', () => {
    const model = DEFAULT_VIRTUAL_MODELS.find((item) => item.name === 'embedding-model');
    if (!model) throw new Error('缺少 embedding-model 虚拟模型');
    expect(model.description).toContain(config.llm.teiModel);
    expect(model.targets).toEqual([{ provider: 'tei', model: config.llm.teiModel, role: 'primary' }]);
  });
});
