/**
 * LLM 路由 —— 虚拟模型、多 Provider 接入、Failover 链（见 4.3 / 4.4）。
 *
 * AgentScope 侧只感知虚拟模型名（如 smart-model），不感知真实 Provider（见 4.1 关键配置）。
 */
import {
  config,
  createLogger,
  monthKey,
  uuid,
  type ChatMessage,
  type Identity,
  type MetadataStore,
  type ToolCall,
  type ToolSpec,
  type VirtualModel,
} from '@eap/platform-core';
import { computeCost } from './pricing.js';
import {
  ProviderError,
  ProviderRegistry,
  egressClassOf,
  isLocalProvider,
  strictEgressClassOf,
  type ProviderChatResult,
  type ProviderStreamDelta,
} from './providers.js';
import type { BudgetService } from './budget.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { GuardrailService } from '../guardrails/index.js';
import type { AuditService } from '../audit/service.js';
import { orderRouteTargets, parseVirtualModel } from './model-config.js';

const log = createLogger('gateway:router');

/** 默认虚拟模型 —— 对应 4.4 Failover 链表 */
export const DEFAULT_VIRTUAL_MODELS: VirtualModel[] = [
  {
    name: 'smart-model',
    description: '主力对话 / 工具调用。MiniMax-M3.1-Flash → MiniMax-M3 → DeepSeek-chat → GPT-4o 兜底',
    scenarios: ['日常对话', '工具调用', 'Agent 主推理'],
    enabled: true,
    targets: [
      { provider: 'minimax', model: 'MiniMax-M3.1-Flash', role: 'primary', weight: 100 },
      { provider: 'minimax', model: 'MiniMax-M3', role: 'fallback' },
      { provider: 'deepseek', model: 'DeepSeek-chat', role: 'fallback' },
      { provider: 'openai', model: 'gpt-4o', role: 'fallback' },
    ],
  },
  {
    name: 'reasoning-model',
    description: '复杂推理。MiniMax-M3 → DeepSeek-R1 → GPT-4o 兜底',
    scenarios: ['复杂推理', '多步规划'],
    enabled: true,
    targets: [
      { provider: 'minimax', model: 'MiniMax-M3', role: 'primary' },
      { provider: 'deepseek', model: 'DeepSeek-R1', role: 'fallback' },
      { provider: 'openai', model: 'gpt-4o', role: 'fallback' },
    ],
  },
  {
    name: 'long-doc-model',
    description: '长文档分析。MiniMax-M3 → 通义 qwen-long',
    scenarios: ['长文档分析', '合同审阅'],
    enabled: true,
    targets: [
      { provider: 'minimax', model: 'MiniMax-M3', role: 'primary' },
      { provider: 'qwen', model: 'qwen-long', role: 'fallback' },
    ],
  },
  {
    name: 'fast-model',
    description: '轻量高并发场景。MiniMax-M2.7-highspeed → MiniMax-M3.1-Flash',
    scenarios: ['意图分类', '标题生成', '简单改写'],
    enabled: true,
    targets: [
      { provider: 'minimax', model: 'MiniMax-M2.7-highspeed', role: 'primary' },
      { provider: 'minimax', model: 'MiniMax-M3.1-Flash', role: 'fallback' },
    ],
  },
  {
    name: 'minimax',
    description: 'MiniMax 专用模型名（只落 MiniMax，不跨厂商 failover）。M3.1-Flash → M3',
    scenarios: ['RAGFlow 等第三方组件', '指定厂商'],
    enabled: true,
    targets: [
      { provider: 'minimax', model: 'MiniMax-M3.1-Flash', role: 'primary', weight: 100 },
      { provider: 'minimax', model: 'MiniMax-M3', role: 'fallback' },
    ],
  },
  {
    name: 'minimax-public',
    description:
      'MiniMax 公有云（开放平台 api.minimax.cn，走网关与出网代理）。M3.1-Flash → M3，只在 MiniMax 内降级',
    scenarios: ['RAGFlow 等第三方组件', '指定厂商', '公有云账号'],
    enabled: true,
    targets: [
      { provider: 'minimax-public', model: 'MiniMax-M3.1-Flash', role: 'primary', weight: 100 },
      { provider: 'minimax-public', model: 'MiniMax-M3', role: 'fallback' },
    ],
  },
  {
    name: 'embedding-model',
    description: `本地 TEI 嵌入（${config.llm.teiModel}），数据不出域`,
    scenarios: ['向量化'],
    enabled: true,
    targets: [{ provider: 'tei', model: config.llm.teiModel, role: 'primary' }],
  },
];

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  appId?: string;
  traceId?: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  id: string;
  model: string;
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  provider: string;
  realModel: string;
  account?: string;
  /** Failover 链上实际经历的跳转变量 */
  failover: { from: string; to: string; reason: string }[];
  traceId: string;
}

export interface EmbedRequest {
  model: string;
  /** OpenAI 兼容：字符串或字符串数组 */
  input: string | string[];
  sessionId?: string;
  appId?: string;
  traceId?: string;
}

export interface EmbedResult {
  id: string;
  model: string;
  embeddings: number[][];
  dimensions: number;
  provider: string;
  realModel: string;
  traceId: string;
}

export class LlmRouter {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly budget: BudgetService,
    private readonly policy: PolicyEngine,
    private readonly guardrails: GuardrailService,
    private readonly audit: AuditService,
    private readonly store: MetadataStore,
    private readonly random: () => number = Math.random,
  ) {}

  /** 初始化虚拟模型到存储 */
  async seedVirtualModels(): Promise<void> {
    const existing = await this.store.listVirtualModels();
    const have = new Map(existing.map((m) => [m.name, m]));
    for (const m of DEFAULT_VIRTUAL_MODELS) {
      const prev = have.get(m.name);
      if (!prev) {
        await this.store.upsertVirtualModel(m);
        continue;
      }
      // 配置驱动的字段（当前只有 TEI 模型名）跟随环境变量更新，
      // 其余字段以存储为准，避免覆盖管理面的人工调整
      const prevTei = prev.targets.find((t) => t.provider === 'tei');
      const nextTei = m.targets.find((t) => t.provider === 'tei');
      if (prevTei && nextTei && prevTei.model !== nextTei.model) {
        const merged: VirtualModel = {
          ...prev,
          targets: prev.targets.map((t) =>
            t.provider === 'tei' ? { ...t, model: nextTei.model } : t,
          ),
        };
        await this.store.upsertVirtualModel(merged);
        log.info('虚拟模型目标已随配置更新', { model: m.name, from: prevTei.model, to: nextTei.model });
      }
    }
    // 环境变量覆盖
    const raw = process.env.EAP_VIRTUAL_MODELS_JSON;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as VirtualModel[];
        for (const value of parsed) {
          try {
            const model = parseVirtualModel(value);
            await this.store.upsertVirtualModel(model);
          } catch (err) {
            log.error('EAP_VIRTUAL_MODELS_JSON 中存在无效模型，已跳过', { error: String(err) });
          }
        }
        log.info('虚拟模型环境变量覆盖已处理', { count: parsed.length });
      } catch (err) {
        log.error('EAP_VIRTUAL_MODELS_JSON 解析失败', { error: String(err) });
      }
    }
  }

  async listVirtualModels(): Promise<VirtualModel[]> {
    return this.store.listVirtualModels();
  }

  /**
   * 主路由方法。顺序：
   *   1) 虚拟模型解析 + 租户模型白名单
   *   2) 策略评估（Cedar/CEL）
   *   3) 预算预检（三级）
   *   4) Guardrails（注入检测 / 数据分级 / 脱敏）
   *   5) Failover 链逐个尝试
   *   6) 记账 + 审计
   */
  async chat(
    req: ChatRequest,
    identity: Identity,
    /**
     * 可选的流式回调。
     *
     * 传入后：
     *   - 适配器实现了 `chatStream` → 走真实上游流式，逐块回调；
     *   - 适配器未实现 → 回退到一次性 `chat()`，把完整正文当成一个大增量回调。
     * 不传该参数时行为与改造前**完全一致**（既有调用方零影响）。
     */
    onContentDelta?: (delta: ProviderStreamDelta) => void,
  ): Promise<ChatResult> {
    const traceId = req.traceId ?? uuid().replace(/-/g, '');
    const requestId = `chatcmpl-${uuid().replace(/-/g, '')}`;

    // —— 1) 虚拟模型
    const vm = await this.store.getVirtualModel(req.model);
    if (!vm || !vm.enabled) {
      throw new ProviderError(`虚拟模型 '${req.model}' 不存在或已禁用`, 404, false, 'gateway');
    }

    const tenant = await this.store.getTenant(identity.tenantId);
    if (!tenant || !tenant.enabled) {
      throw new ProviderError(`租户 ${identity.tenantId} 不存在或已禁用`, 403, false, 'gateway');
    }
    if (tenant.models.length > 0 && !tenant.models.includes(vm.name)) {
      throw new ProviderError(
        `租户模型白名单拒绝：${vm.name} 不在租户 ${tenant.id} 的允许列表内`,
        403,
        false,
        'gateway',
      );
    }

    // —— 2) 策略
    // 出网级别决定涉密主体是否放行（见 8.1）：虚拟模型只要含本地目标，
    // 涉密请求即可走本地路径；纯商业目标则被 deny-confidential-egress 拒绝。
    const egress = egressClassOf(vm.targets.map((t) => t.provider));
    const decision = this.policy.evaluate({
      identity,
      service: 'llm',
      operation: 'chat',
      model: vm.name,
      egress,
    });
    if (!decision.allowed) {
      await this.audit.record({
        kind: 'llm',
        identity,
        traceId,
        model: vm.name,
        status: 'blocked',
        reason: decision.reason,
        sessionId: req.sessionId,
        appId: req.appId,
        detail: { matchedPolicies: decision.matched },
      });
      throw new ProviderError(decision.reason, 403, false, 'gateway');
    }

    // —— 3) 预算预检
    const maxTokens = req.maxTokens ?? 4096;
    const estimatedPromptTokens = Math.ceil(
      req.messages.reduce((total, message) => total + message.content.length, 0) / 2,
    );
    const budgetDecision = await this.budget.check(identity, req.appId, maxTokens + estimatedPromptTokens);
    if (!budgetDecision.allowed) {
      await this.audit.record({
        kind: 'llm',
        identity,
        traceId,
        model: vm.name,
        status: 'blocked',
        reason: budgetDecision.reason,
        sessionId: req.sessionId,
        appId: req.appId,
        detail: { scope: budgetDecision.scope, action: budgetDecision.action },
      });
      throw new ProviderError(budgetDecision.reason ?? '预算超限', 429, false, 'gateway');
    }
    if (budgetDecision.action === 'alert') {
      log.warn('预算告警', { reason: budgetDecision.reason, tenant: identity.tenantId });
      await this.audit.record({
        kind: 'llm',
        identity,
        traceId,
        model: vm.name,
        status: 'ok',
        reason: `预算告警：${budgetDecision.reason}`,
        sessionId: req.sessionId,
        appId: req.appId,
      });
    }

    // —— 4) Guardrails
    const guardrailEgress = identity.sensitivity === 'confidential'
      ? egress
      : strictEgressClassOf(vm.targets.map((t) => t.provider));
    const guardedMessages: ChatMessage[] = [];
    const allPiiHits: Record<string, number> = {};
    for (const m of req.messages) {
      const g = this.guardrails.apply({
        text: m.content,
        sensitivity: identity.sensitivity,
        egress: guardrailEgress,
      });
      if (g.blocked) {
        await this.audit.record({
          kind: 'llm',
          identity,
          traceId,
          model: vm.name,
          status: 'blocked',
          reason: g.reason,
          sessionId: req.sessionId,
          appId: req.appId,
          detail: { injectionSignals: g.injectionSignals },
        });
        throw new ProviderError(g.reason ?? '护栏拦截', 400, false, 'gateway');
      }
      for (const h of g.piiHits) {
        allPiiHits[h.rule] = (allPiiHits[h.rule] ?? 0) + h.count;
      }
      guardedMessages.push({ ...m, content: g.text });
    }
    if (Object.keys(allPiiHits).length > 0) {
      log.info('PII 脱敏完成', { hits: allPiiHits, traceId });
    }

    // —— 5) Failover 链
    const failover: { from: string; to: string; reason: string }[] = [];
    // 涉密主体只允许本地推理目标 —— Failover 链里的商业目标一律跳过（见 8.1 数据分级与路由）。
    // 策略层已保证：纯商业目标的虚拟模型对涉密主体是 deny，不会走到这里。
    const confidential = identity.sensitivity === 'confidential';
    const targets = orderRouteTargets(
      confidential ? vm.targets.filter((t) => isLocalProvider(t.provider)) : vm.targets,
      this.random,
    );
    if (confidential && targets.length === 0) {
      const reason = `虚拟模型 '${vm.name}' 无本地推理目标，涉密数据禁止出网（见 8.1）`;
      await this.audit.record({
        kind: 'llm',
        identity,
        traceId,
        model: vm.name,
        status: 'blocked',
        reason,
        sessionId: req.sessionId,
        appId: req.appId,
      });
      throw new ProviderError(reason, 403, false, 'gateway');
    }
    let lastError: ProviderError | undefined;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (target.provider === 'tei') {
        // 嵌入模型不支持对话接口 —— 引导走 /v1/embeddings
        lastError = new ProviderError(
          `嵌入模型 '${target.model}' 不支持对话接口，请调用 /v1/embeddings`,
          400,
          false,
          'tei',
        );
        failover.push({
          from: `${target.provider}/${target.model}`,
          to: targets[i + 1] ? `${targets[i + 1].provider}/${targets[i + 1].model}` : 'none',
          reason: lastError.message,
        });
        continue;
      }
      const adapter = this.providers.get(target.provider);
      if (!adapter) {
        lastError = new ProviderError(
          `provider '${target.provider}' 未配置或未连接`,
          503,
          true,
          target.provider,
        );
        failover.push({
          from: `${target.provider}/${target.model}`,
          to: targets[i + 1] ? `${targets[i + 1].provider}/${targets[i + 1].model}` : 'none',
          reason: lastError.message,
        });
        continue;
      }

      let attempt = 0;
      let result: ProviderChatResult | undefined;
      let emptyRetry = false;
      /**
       * 本次尝试是否已经向上层吐过增量。
       * 一旦吐过就不能再重试/故障转移 —— 客户端已经收到了半截内容，
       * 换模型重发会导致内容重复。只能在「还没吐出任何内容」时安全重试。
       */
      let emitted = false;
      while (attempt <= config.llm.maxRetries) {
        emitted = false;
        try {
          const input = {
            model: target.model,
            messages: guardedMessages,
            tools: req.tools,
            temperature: req.temperature,
            maxTokens: target.maxTokens ?? maxTokens,
            timeoutMs: config.llm.timeoutMs,
            account: target.account,
            signal: req.signal,
          };
          const call = async (maxTok: number): Promise<ProviderChatResult> => {
            const args = { ...input, maxTokens: maxTok };
            if (onContentDelta && adapter.chatStream) {
              const masker = this.guardrails.createStreamMasker((text) => {
                emitted = true;
                onContentDelta({ contentDelta: text });
              });
              const r = await adapter.chatStream(args, (d) => {
                if (d.contentDelta) masker.push(d.contentDelta);
                if (d.toolCallDelta) {
                  masker.flush();
                  emitted = true;
                  onContentDelta({ toolCallDelta: d.toolCallDelta });
                }
              });
              masker.flush();
              return r;
            }
            const r = await adapter.chat(args);
            if (onContentDelta && r.content) {
              const text = this.guardrails.maskOutput(r.content).text;
              emitted = true;
              onContentDelta({ contentDelta: text });
            }
            return r;
          };

          result = await call(input.maxTokens);
          // 推理模型可能把输出预算全部消耗在 thinking 上，导致正文为空。
          // 无工具调用且正文为空时，用更大预算重试一次。
          if (
            result &&
            !result.toolCalls.length &&
            !result.content.trim() &&
            !emptyRetry
          ) {
            emptyRetry = true;
            log.warn('模型正文为空（可能输出预算被 thinking 占满），加大预算重试', {
              provider: target.provider,
              model: target.model,
            });
            result = await call((target.maxTokens ?? maxTokens) * 2);
          }
          break;
        } catch (err) {
          if (emitted) {
            // 已经吐过增量，不能重试也不能故障转移 —— 直接上抛
            log.warn('流式已输出内容后失败，不重试', {
              provider: target.provider,
              error: String(err),
            });
            throw err;
          }
          lastError = err instanceof ProviderError ? err : new ProviderError(String(err), 502, true, target.provider);
          attempt++;
          if (!lastError.retryable || attempt > config.llm.maxRetries) break;
          log.warn('provider 重试', { provider: target.provider, attempt, error: lastError.message });
        }
      }

      if (result) {
        // 正文仍为空时给出明确说明，避免静默返回空答案
        if (!result.content.trim() && !result.toolCalls.length) {
          result.content =
            '模型本次只产生了推理内容、未输出最终答案。' +
            '建议重试，或改用 reasoning-model 以外更适合直接作答的虚拟模型。';
        }
        const outputMask = this.guardrails.maskOutput(result.content);
        result.content = outputMask.text;
        const cost = computeCost(target.model, result.promptTokens, result.completionTokens);

        // —— 6) 记账 + 审计
        await this.budget.record(
          identity,
          req.appId,
          target.model,
          result.promptTokens,
          result.completionTokens,
          cost,
        );
        await this.audit.record({
          kind: 'llm',
          identity,
          traceId,
          model: vm.name,
          provider: target.provider,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: cost,
          status: 'ok',
          sessionId: req.sessionId,
          appId: req.appId,
          detail: {
            realModel: target.model,
            account: target.account,
            failover,
            piiHits: allPiiHits,
            month: monthKey(),
          },
        });

        return {
          id: requestId,
          model: vm.name,
          content: result.content,
          toolCalls: result.toolCalls,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: cost,
          provider: target.provider,
          realModel: target.model,
          account: target.account,
          failover,
          traceId,
        };
      }

      const next = targets[i + 1];
      failover.push({
        from: `${target.provider}/${target.model}`,
        to: next ? `${next.provider}/${next.model}` : 'none',
        reason: lastError?.message ?? 'unknown',
      });
      log.warn('Failover 触发', {
        from: `${target.provider}/${target.model}`,
        to: next ? `${next.provider}/${next.model}` : 'none',
        reason: lastError?.message,
      });
    }

    await this.audit.record({
      kind: 'llm',
      identity,
      traceId,
      model: vm.name,
      status: 'error',
      reason: lastError?.message ?? '全部 Failover 目标失败',
      sessionId: req.sessionId,
      appId: req.appId,
      detail: { failover },
    });

    throw new ProviderError(
      `所有 Failover 目标均失败：${lastError?.message ?? '未知错误'}`,
      lastError?.status ?? 502,
      false,
      'gateway',
    );
  }

  /**
   * 嵌入路由 —— 对应 4.2「本地 Embedding，数据不出域」。
   *
   * 与 chat 的差异：
   *   - 只允许 TEI（内网）Provider，禁止走商业 API
   *   - 不计费（本地推理），但仍受租户预算熔断与应用级 QPS 限流保护
   *   - 输入同样过护栏（PII 脱敏 + 注入检测）
   */
  async embed(req: EmbedRequest, identity: Identity): Promise<EmbedResult> {
    const traceId = req.traceId ?? uuid().replace(/-/g, '');
    const requestId = `embed-${uuid().replace(/-/g, '')}`;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    if (!inputs.length || inputs.every((s) => !s || !s.trim())) {
      throw new ProviderError('input 不能为空', 400, false, 'gateway');
    }

    // —— 1) 虚拟模型（必须是嵌入型模型）
    const vm = await this.store.getVirtualModel(req.model);
    if (!vm || !vm.enabled) {
      throw new ProviderError(`虚拟模型 '${req.model}' 不存在或已禁用`, 404, false, 'gateway');
    }
    const target = vm.targets.find((t) => t.provider === 'tei');
    if (!target) {
      throw new ProviderError(
        `虚拟模型 '${req.model}' 未配置 TEI 嵌入目标，不能用于向量化`,
        400,
        false,
        'gateway',
      );
    }

    const tenant = await this.store.getTenant(identity.tenantId);
    if (!tenant || !tenant.enabled) {
      throw new ProviderError(`租户 ${identity.tenantId} 不存在或已禁用`, 403, false, 'gateway');
    }
    if (tenant.models.length > 0 && !tenant.models.includes(vm.name)) {
      throw new ProviderError(
        `租户模型白名单拒绝：${vm.name} 不在租户 ${tenant.id} 的允许列表内`,
        403,
        false,
        'gateway',
      );
    }

    // —— 2) 策略
    // TEI 是内网本地推理（数据不出域）—— 涉密主体同样允许走这条路径（见 8.1）
    const decision = this.policy.evaluate({
      identity,
      service: 'llm',
      operation: 'embed',
      model: vm.name,
      egress: 'local',
    });
    if (!decision.allowed) {
      await this.audit.record({
        kind: 'llm',
        identity,
        traceId,
        model: vm.name,
        status: 'blocked',
        reason: decision.reason,
        sessionId: req.sessionId,
        appId: req.appId,
        detail: { matchedPolicies: decision.matched, operation: 'embed' },
      });
      throw new ProviderError(decision.reason, 403, false, 'gateway');
    }

    // —— 3) 预算预检（本地推理不计费，但仍受熔断/QPS 保护）
    const estimatedTokens = Math.ceil(inputs.join('\n').length / 2);
    const budgetDecision = await this.budget.check(identity, req.appId, estimatedTokens);
    if (!budgetDecision.allowed) {
      await this.audit.record({
        kind: 'llm',
        identity,
        traceId,
        model: vm.name,
        status: 'blocked',
        reason: budgetDecision.reason,
        sessionId: req.sessionId,
        appId: req.appId,
        detail: { scope: budgetDecision.scope, action: budgetDecision.action, operation: 'embed' },
      });
      throw new ProviderError(budgetDecision.reason ?? '预算超限', 429, false, 'gateway');
    }

    // —— 4) 护栏
    const guarded: string[] = [];
    const allPiiHits: Record<string, number> = {};
    for (const text of inputs) {
      const g = this.guardrails.apply({
        text,
        sensitivity: identity.sensitivity,
        egress: 'local',
      });
      if (g.blocked) {
        await this.audit.record({
          kind: 'llm',
          identity,
          traceId,
          model: vm.name,
          status: 'blocked',
          reason: g.reason,
          sessionId: req.sessionId,
          appId: req.appId,
          detail: { injectionSignals: g.injectionSignals, operation: 'embed' },
        });
        throw new ProviderError(g.reason ?? '护栏拦截', 400, false, 'gateway');
      }
      for (const h of g.piiHits) {
        allPiiHits[h.rule] = (allPiiHits[h.rule] ?? 0) + h.count;
      }
      guarded.push(g.text);
    }

    // —— 5) 调用 TEI
    const tei = this.providers.getTei();
    if (!tei) {
      throw new ProviderError('TEI 嵌入服务未配置（TEI_BASE_URL 为空）', 503, false, 'tei');
    }
    const embeddings = await tei.embed(guarded);
    if (!embeddings.length) {
      throw new ProviderError('TEI 未返回向量结果', 502, true, 'tei');
    }

    // —— 6) 审计
    await this.audit.record({
      kind: 'llm',
      identity,
      traceId,
      model: vm.name,
      provider: 'tei',
      promptTokens: estimatedTokens,
      completionTokens: 0,
      costUsd: 0,
      status: 'ok',
      sessionId: req.sessionId,
      appId: req.appId,
      detail: {
        realModel: target.model,
        operation: 'embed',
        inputs: inputs.length,
        dimensions: embeddings[0]?.length ?? 0,
        piiHits: allPiiHits,
        month: monthKey(),
      },
    });

    return {
      id: requestId,
      model: vm.name,
      embeddings,
      dimensions: embeddings[0]?.length ?? 0,
      provider: 'tei',
      realModel: target.model,
      traceId,
    };
  }
}
