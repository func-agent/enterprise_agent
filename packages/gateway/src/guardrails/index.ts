/**
 * Guardrails —— 网关内置安全护栏（见 4.3 内置能力、8.1 数据分级与路由、8.2 PII 脱敏）。
 *
 * 方案不引入独立脱敏服务（3.2 排除 Presidio），采用「网关内置正则脱敏 + DB-GPT 内置脱敏」双保险。
 */
import { readFileSync, existsSync } from 'node:fs';
import { config, createLogger } from '@eap/platform-core';
import type { SensitivityLevel } from '@eap/platform-core';

const log = createLogger('gateway:guardrails');

export interface PiiRule {
  name: string;
  pattern: RegExp;
  replacement: string;
  enabled: boolean;
}

export interface PiiHit {
  rule: string;
  count: number;
}

/** 内置正则规则库 —— 身份证 / 手机号 / 银行卡 / 内部工号 / 密钥格式（见 8.2 第 1 条） */
export const DEFAULT_PII_RULES: PiiRule[] = [
  { name: '身份证号', pattern: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, replacement: '{{id_card}}', enabled: true },
  { name: '手机号', pattern: /\b1[3-9]\d{9}\b/g, replacement: '{{phone}}', enabled: true },
  { name: '银行卡号', pattern: /\b\d{16,19}\b/g, replacement: '{{bank_card}}', enabled: true },
  { name: '内部工号', pattern: /\bEMP\d{6,10}\b/g, replacement: '{{employee_id}}', enabled: true },
  { name: '密钥格式', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: '{{secret_key}}', enabled: true },
  { name: '邮箱', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replacement: '{{email}}', enabled: true },
];

export interface InjectionSignal {
  rule: string;
  matched: string;
  severity: 'low' | 'medium' | 'high';
}

/** Prompt 注入检测规则（见 8.3 网关脱敏 + 注入防护） */
export const INJECTION_RULES: { name: string; pattern: RegExp; severity: 'low' | 'medium' | 'high' }[] = [
  { name: '忽略既有指令', pattern: /忽略(?:掉)?(?:以上|之前|前面|前面所有)?(?:的)?(?:所有)?(?:指令|提示|命令|要求|设定)/i, severity: 'high' },
  { name: '英文忽略指令', pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i, severity: 'high' },
  { name: '泄露系统提示', pattern: /(?:reveal|show|print|output|repeat)\s+(?:me\s+)?(?:your\s+)?(?:the\s+)?(?:system\s+)?(?:prompt|instructions?)/i, severity: 'high' },
  { name: '角色劫持', pattern: /(?:你现在是|你扮演|假装你是|act\s+as|you\s+are\s+now)\s*[「"']?(?:DAN|越狱|jailbreak|不受限制|无限制)/i, severity: 'high' },
  { name: '绕过安全', pattern: /(?:绕过|规避|禁用|关闭)(?:所有)?(?:安全|限制|护栏|审查|过滤|对齐)/i, severity: 'high' },
  { name: '英文绕过安全', pattern: /(?:bypass|disable|turn\s+off)\s+(?:all\s+)?(?:safety|security|guardrails?|restrictions?|filters?)/i, severity: 'high' },
  { name: '系统提示词标记', pattern: /<\/?(?:system|assistant|human)>|\[SYSTEM\]|\{\{\s*system\s*\}\}/i, severity: 'medium' },
  { name: '疑似编码载荷', pattern: /[A-Za-z0-9+/]{180,}={0,2}/, severity: 'medium' },
];

/** 密级识别标记（见 8.1 数据级别） */
const CONFIDENTIAL_MARKERS = [
  /绝密/,
  /机密/,
  /涉密/,
  /\bTOP\s*SECRET\b/i,
  /\bCONFIDENTIAL\b/i,
  /内部\s*秘密/,
];

export interface GuardrailInput {
  text: string;
  /** 调用方声明的数据密级 */
  sensitivity: SensitivityLevel;
  /**
   * 出网级别（见 8.1）：
   *   - `local`    —— 内网/本机推理，数据不出域
   *   - `external` —— 商业 API 推理，数据出网
   * 不传时按 `external` 处理（保守默认）。
   */
  egress?: 'local' | 'external';
}

export interface GuardrailOutput {
  /** 处理后的文本 */
  text: string;
  /** 是否阻断 */
  blocked: boolean;
  reason?: string;
  piiHits: PiiHit[];
  injectionSignals: InjectionSignal[];
  /** 实际生效的密级（可能被文本标记上调） */
  effectiveSensitivity: SensitivityLevel;
}

export class GuardrailService {
  private rules: PiiRule[];

  constructor() {
    this.rules = [...DEFAULT_PII_RULES];
    this.loadCustomRules();
  }

  /** 规则库由平台组维护，配置文件形式，持续迭代（见 8.2 运营要求） */
  private loadCustomRules() {
    const file = config.guardrails.customRulesFile;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        rules?: { name: string; pattern: string; replacement: string; enabled?: boolean }[];
      };
      for (const r of raw.rules ?? []) {
        this.rules.push({
          name: r.name,
          pattern: new RegExp(r.pattern, 'g'),
          replacement: r.replacement,
          enabled: r.enabled !== false,
        });
      }
      log.info('已加载自定义脱敏规则', { file, count: this.rules.length });
    } catch (err) {
      log.error('自定义脱敏规则加载失败', { file, error: String(err) });
    }
  }

  /** 正则脱敏 —— 命中即替换为占位符 */
  maskPii(text: string): { text: string; hits: PiiHit[] } {
    if (!config.guardrails.piiMaskingEnabled) return { text, hits: [] };
    let out = text;
    const hits: PiiHit[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let count = 0;
      out = out.replace(re, () => {
        count++;
        return rule.replacement;
      });
      if (count > 0) hits.push({ rule: rule.name, count });
    }
    return { text: out, hits };
  }

  /**
   * 只统计不替换 —— 本地推理场景使用。
   * 数据不出域时无需改写原文（占位符会破坏向量语义），
   * 但命中情况仍要进审计，供合规核查。
   */
  scanPii(text: string): PiiHit[] {
    if (!config.guardrails.piiMaskingEnabled) return [];
    const hits: PiiHit[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      const m = re.exec(text);
      if (m) hits.push({ rule: rule.name, count: text.match(re)?.length ?? 1 });
    }
    return hits;
  }

  /** Prompt 注入检测 */
  detectInjection(text: string): InjectionSignal[] {
    if (!config.guardrails.injectionDetectionEnabled) return [];
    const signals: InjectionSignal[] = [];
    for (const rule of INJECTION_RULES) {
      const m = rule.pattern.exec(text);
      if (m) {
        signals.push({ rule: rule.name, matched: m[0].slice(0, 80), severity: rule.severity });
      }
    }
    return signals;
  }

  /** 文本密级识别 —— 命中机密标记则上调密级 */
  classifyText(text: string, declared: SensitivityLevel): SensitivityLevel {
    for (const re of CONFIDENTIAL_MARKERS) {
      if (re.test(text)) return 'confidential';
    }
    return declared;
  }

  /**
   * 完整护栏处理链：
   *  1) 注入检测 —— 命中 high 级则阻断
   *  2) 密级判定 —— 涉密数据禁止出网；本地推理（数据不出域）不受此限（见 8.1）
   *  3) 正则脱敏 —— 出网场景改写原文；本地推理只统计不替换
   */
  apply(input: GuardrailInput): GuardrailOutput {
    const injectionSignals = this.detectInjection(input.text);
    const highInjection = injectionSignals.find((s) => s.severity === 'high');

    const effectiveSensitivity = this.classifyText(input.text, input.sensitivity);
    const egress = input.egress ?? 'external';
    const isLocal = egress === 'local';

    // 涉密强制不出网：仅对出网（商业 API）生效。
    // 本地推理（TEI 等）数据不出域，本就是 8.1 要求的合规闭环，不应拦截。
    if (
      effectiveSensitivity === 'confidential' &&
      !isLocal &&
      config.guardrails.blockConfidentialEgress
    ) {
      return {
        text: input.text,
        blocked: true,
        reason: '涉密数据强制本地闭环，禁止出网调用商业模型（见 8.1 数据分级与路由）',
        piiHits: [],
        injectionSignals,
        effectiveSensitivity,
      };
    }

    if (highInjection) {
      return {
        text: input.text,
        blocked: true,
        reason: `检测到 Prompt 注入特征：${highInjection.rule}（${highInjection.matched}）`,
        piiHits: [],
        injectionSignals,
        effectiveSensitivity,
      };
    }

    if (isLocal) {
      // 数据不出域：保留原文，仅统计 PII 命中供审计
      return {
        text: input.text,
        blocked: false,
        piiHits: this.scanPii(input.text),
        injectionSignals,
        effectiveSensitivity,
      };
    }

    const { text, hits } = this.maskPii(input.text);
    return {
      text,
      blocked: false,
      piiHits: hits,
      injectionSignals,
      effectiveSensitivity,
    };
  }

  /** 工具返回值同样需要脱敏后返回 */
  maskOutput(text: string): { text: string; hits: PiiHit[] } {
    return this.maskPii(text);
  }

  maskStructured<T>(value: T): { value: T; hits: PiiHit[] } {
    const counts = new Map<string, number>();
    const seen = new WeakSet<object>();
    const visit = (input: unknown, depth: number): unknown => {
      if (typeof input === 'string') {
        const masked = this.maskPii(input);
        for (const hit of masked.hits) counts.set(hit.rule, (counts.get(hit.rule) ?? 0) + hit.count);
        return masked.text;
      }
      if (input === null || typeof input !== 'object') return input;
      if (seen.has(input)) return '[circular reference removed]';
      if (depth >= 64) return '[maximum nesting depth exceeded]';
      seen.add(input);
      if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [key, visit(item, depth + 1)]),
      );
    };
    return {
      value: visit(value, 0) as T,
      hits: [...counts].map(([rule, count]) => ({ rule, count })),
    };
  }

  createStreamMasker(emit: (text: string) => void) {
    const holdBackChars = 512;
    let pending = '';
    return {
      push: (delta: string) => {
        pending += delta;
        if (pending.length <= holdBackChars) return;
        let cut = pending.length - holdBackChars;
        const partialToken = pending.slice(0, cut).match(/[A-Za-z0-9_@.+/-]+$/)?.[0];
        if (partialToken) cut -= partialToken.length;
        if (cut <= 0) return;
        const text = this.maskPii(pending.slice(0, cut)).text;
        pending = pending.slice(cut);
        if (text) emit(text);
      },
      flush: () => {
        const text = this.maskPii(pending).text;
        pending = '';
        if (text) emit(text);
      },
    };
  }
}
