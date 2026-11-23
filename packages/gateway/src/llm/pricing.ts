/**
 * 模型计价表 —— 用于成本归因（见 11.2 成本管理：按租户/部门/应用/模型出 Token 与金额报表）。
 * 可通过 PRICING_JSON 环境变量覆盖，格式：{ "<model>": { "input": <每千 token 美元>, "output": <...> } }
 */
import { config } from '@eap/platform-core';

export interface ModelPrice {
  /** 每千输入 token 价格（USD） */
  input: number;
  /** 每千输出 token 价格（USD） */
  output: number;
}

const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // MiniMax —— 默认值需按实际合同调整
  'MiniMax-M3': { input: 0.001, output: 0.003 },
  'MiniMax-M3.1-Flash': { input: 0.0005, output: 0.0015 },
  'MiniMax-M2.7': { input: 0.001, output: 0.003 },
  // 通义
  'qwen-max': { input: 0.0024, output: 0.0096 },
  'qwen-long': { input: 0.0005, output: 0.0005 },
  'qwen-plus': { input: 0.0008, output: 0.0032 },
  // DeepSeek
  'DeepSeek-chat': { input: 0.00027, output: 0.0011 },
  'DeepSeek-R1': { input: 0.00055, output: 0.00219 },
  // 智谱 / OpenAI 高端兜底
  'glm-4-plus': { input: 0.005, output: 0.005 },
  'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
  'gpt-4o': { input: 0.0025, output: 0.01 },
};

function loadPricing(): Record<string, ModelPrice> {
  const raw = process.env.PRICING_JSON;
  if (!raw) return DEFAULT_PRICING;
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    return { ...DEFAULT_PRICING, ...parsed };
  } catch {
    return DEFAULT_PRICING;
  }
}

const PRICING = loadPricing();

export function priceOf(model: string): ModelPrice {
  return PRICING[model] ?? { input: 0, output: 0 };
}

/** 计算一次调用的成本（USD） */
export function computeCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceOf(model);
  return (
    (promptTokens / 1000) * p.input +
    (completionTokens / 1000) * p.output
  );
}

/** 单次请求的最大预估成本，用于应用级预算预检 */
export function estimateCost(model: string, maxTokens: number): number {
  const p = priceOf(model);
  return ((maxTokens / 1000) * p.input * 3 + (maxTokens / 1000) * p.output) || 0;
}

export { DEFAULT_PRICING, config };
