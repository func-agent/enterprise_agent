/**
 * 管理接口 —— 租户、配额、策略、审计、审批、Trace。
 * 管理操作全部记录审计（见 8.4 审计要求：租户开通 / 配额变更 / Key 轮换全记录）。
 */
import { Router, type Request, type Response } from 'express';
import { config, createLogger, uuid } from '@eap/platform-core';
import type { AppContext } from '../context.js';
import { requireIdentity } from '@eap/auth-middleware';
import type { Tenant } from '@eap/platform-core';
import { KB_DELETE_TOOL, KB_UPSERT_TOOL, executeApprovedKnowledgeWrite } from './knowledge.js';
import { CredentialError } from '../llm/credentials.js';
import { ModelConfigError, parseVirtualModel } from '../llm/model-config.js';
import { ProviderConfigError, parseProviderDefinition } from '../llm/provider-config.js';
import {
  KeycloakUserError,
  type ManagedUser,
  type ManagedUserInput,
  type ManagedUserUpdate,
} from '../identity/user-admin.js';
import { asyncHandler } from '../async-handler.js';

const log = createLogger('gateway:route:admin');

const ADMIN_ROLES = new Set(['admin', 'platform-admin']);
/** 有权审批的角色（见 8.4 管理操作需全记录；审批是高风险管理操作） */
const APPROVER_ROLES = new Set(['admin', 'platform-admin', 'manager']);

export function adminRoutes(ctx: AppContext): Router {
  const router = Router();

  /** 管理操作审计包装 */
  const auditAdmin = async (
    req: Request,
    action: string,
    detail: Record<string, unknown>,
    status: 'ok' | 'error' | 'blocked' = 'ok',
  ) => {
    const identity = requireIdentity(req);
    await ctx.audit.record({
      kind: 'admin',
      identity,
      traceId: `admin-${uuid()}`,
      status,
      reason: action,
      detail,
    });
  };

  const assertAdmin = (req: Request, res: Response): boolean => {
    const identity = requireIdentity(req);
    if (!ADMIN_ROLES.has(identity.role)) {
      res.status(403).json({ error: 'forbidden', message: '需要管理员角色' });
      return false;
    }
    return true;
  };

  const assertPlatformAdmin = (req: Request, res: Response): boolean => {
    const identity = requireIdentity(req);
    if (identity.role !== 'platform-admin') {
      res.status(403).json({ error: 'forbidden', message: '用户与权限管理仅允许平台管理员操作' });
      return false;
    }
    return true;
  };

  const handleUserError = async (
    req: Request,
    res: Response,
    action: string,
    detail: Record<string, unknown>,
    err: unknown,
  ): Promise<void> => {
    const message = err instanceof Error ? err.message : '用户管理操作失败';
    await auditAdmin(req, `${action}.error`, { ...detail, message }, 'error');
    if (err instanceof KeycloakUserError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  };

  const assertTenantAvailable = async (tenantId: string): Promise<void> => {
    const tenant = await ctx.store.getTenant(tenantId);
    if (!tenant || !tenant.enabled) {
      throw new KeycloakUserError(400, 'invalid_tenant', `租户 '${tenantId}' 不存在或已停用`);
    }
  };

  const assertNotLastPlatformAdmin = async (target: ManagedUser): Promise<void> => {
    if (target.role !== 'platform-admin' || !target.enabled) return;
    const users = await ctx.userAdmin.list();
    const enabledAdmins = users.filter((user) => user.role === 'platform-admin' && user.enabled);
    if (enabledAdmins.length <= 1) {
      throw new KeycloakUserError(409, 'last_platform_admin', '不能移除最后一个启用中的平台管理员');
    }
  };

  const userInput = (body: Record<string, unknown>, username = ''): ManagedUserInput => ({
    username: String(body.username ?? username),
    email: String(body.email ?? ''),
    firstName: String(body.firstName ?? ''),
    lastName: String(body.lastName ?? ''),
    role: String(body.role ?? ''),
    tenantId: String(body.tenantId ?? ''),
    deptId: String(body.deptId ?? ''),
    sensitivity: String(body.sensitivity ?? ''),
  });

  // —— 租户
  router.get('/v1/admin/tenants', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    res.json({ data: await ctx.store.listTenants() });
  });

  router.post('/v1/admin/tenants', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const b = req.body ?? {};
    const tenant: Tenant = {
      id: String(b.id ?? `t-${uuid().slice(0, 8)}`),
      name: String(b.name ?? '未命名租户'),
      models: Array.isArray(b.models) ? b.models : [],
      tools: Array.isArray(b.tools) ? b.tools : [],
      knowledgeBases: Array.isArray(b.knowledgeBases) ? b.knowledgeBases : [],
      monthlyBudgetUsd: Number(b.monthlyBudgetUsd ?? 0),
      monthlyTokenBudget: Number(b.monthlyTokenBudget ?? 0),
      enabled: b.enabled !== false,
    };
    await ctx.store.upsertTenant(tenant);
    await auditAdmin(req, 'tenant.upsert', { tenantId: tenant.id, name: tenant.name, budget: tenant.monthlyBudgetUsd });
    res.json({ data: tenant });
  });

  // —— 预算看板
  router.get('/v1/admin/budget', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const identity = requireIdentity(req);
    const scope = identity.role === 'platform-admin' ? undefined : identity.tenantId;
    res.json(await ctx.budget.summary(scope));
  });

  // —— 审计
  router.get('/v1/admin/audit', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const identity = requireIdentity(req);
    const tenantId =
      identity.role === 'platform-admin'
        ? (req.query.tenant_id as string | undefined)
        : identity.tenantId;
    const events = await ctx.audit.list({
      tenantId,
      kind: req.query.kind as string | undefined,
      limit: Number(req.query.limit ?? 200),
    });
    res.json({ data: events });
  });

  /** 按 trace 还原完整调用链 */
  router.get('/v1/admin/audit/:traceId', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const identity = requireIdentity(req);
    const tenantId = identity.role === 'platform-admin' ? undefined : identity.tenantId;
    res.json(await ctx.audit.reconstruct(String(req.params.traceId), tenantId));
  });

  // —— 策略
  router.get('/v1/admin/policies', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    res.json({ data: ctx.policy.list() });
  });

  router.put('/v1/admin/policies', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const policies = Array.isArray(req.body?.policies) ? req.body.policies : [];
    ctx.policy.replaceAll(policies);
    await auditAdmin(req, 'policy.replace', { count: policies.length });
    res.json({ data: ctx.policy.list() });
  });

  // —— 虚拟模型与路由
  const assertRouteTargets = (targets: { provider: string; account?: string }[]): void => {
    const providers = ctx.providers.describe();
    for (const target of targets) {
      const provider = providers.find((item) => item.name === target.provider);
      if (!provider) throw new ModelConfigError(`Provider '${target.provider}' 未注册，请先配置其 BASE_URL`);
      if (target.account && !provider.accounts.includes(target.account)) {
        throw new ModelConfigError(`Provider '${target.provider}' 不存在账号 '${target.account}'，请先在网关环境变量中配置对应账号的 API Key`);
      }
    }
  };

  router.get('/v1/admin/models', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    res.json({
      data: await ctx.store.listVirtualModels(),
      providers: ctx.providers.describe(),
      defaultModel: config.agent.defaultModel,
    });
  });

  router.post('/v1/admin/models', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    try {
      const model = parseVirtualModel(req.body);
      assertRouteTargets(model.targets);
      if (await ctx.store.getVirtualModel(model.name)) {
        res.status(409).json({ error: 'model_exists', message: `虚拟模型 '${model.name}' 已存在` });
        return;
      }
      // 与编辑/启停/删除保持一致：默认模型一旦存在就必须处于可用状态
      if (model.name === config.agent.defaultModel && !model.enabled) {
        res.status(409).json({ error: 'default_model_in_use', message: '当前默认对话模型必须保持启用，请先通过 AGENT_DEFAULT_MODEL 更换默认模型' });
        return;
      }
      await ctx.store.upsertVirtualModel(model);
      await auditAdmin(req, 'model.create', { model });
      res.status(201).json({ data: model });
    } catch (err) {
      if (!(err instanceof ModelConfigError)) throw err;
      res.status(400).json({ error: 'invalid_model', message: err.message, issues: err.issues });
    }
  });

  router.put('/v1/admin/models/:name', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    try {
      const name = String(req.params.name);
      const previous = await ctx.store.getVirtualModel(name);
      if (!previous) {
        res.status(404).json({ error: 'model_not_found', message: `虚拟模型 '${name}' 不存在` });
        return;
      }
      const model = parseVirtualModel(req.body, name);
      if (name === config.agent.defaultModel && !model.enabled) {
        res.status(409).json({ error: 'default_model_in_use', message: '当前默认对话模型必须保持启用，请先通过 AGENT_DEFAULT_MODEL 更换默认模型' });
        return;
      }
      assertRouteTargets(model.targets);
      await ctx.store.upsertVirtualModel(model);
      await auditAdmin(req, 'model.update', { model: name, previous, current: model });
      res.json({ data: model });
    } catch (err) {
      if (!(err instanceof ModelConfigError)) throw err;
      res.status(400).json({ error: 'invalid_model', message: err.message, issues: err.issues });
    }
  });

  router.patch('/v1/admin/models/:name', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'invalid_model', message: 'enabled 必须为布尔值' });
      return;
    }
    const name = String(req.params.name);
    const previous = await ctx.store.getVirtualModel(name);
    if (!previous) {
      res.status(404).json({ error: 'model_not_found', message: `虚拟模型 '${name}' 不存在` });
      return;
    }
    if (name === config.agent.defaultModel && !req.body.enabled) {
      res.status(409).json({ error: 'default_model_in_use', message: '当前默认对话模型不能禁用，请先通过 AGENT_DEFAULT_MODEL 更换默认模型' });
      return;
    }
    const model = { ...previous, enabled: req.body.enabled as boolean };
    await ctx.store.upsertVirtualModel(model);
    await auditAdmin(req, model.enabled ? 'model.enable' : 'model.disable', { model: name });
    res.json({ data: model });
  });

  router.delete('/v1/admin/models/:name', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const name = String(req.params.name);
    if (!(await ctx.store.getVirtualModel(name))) {
      res.status(404).json({ error: 'model_not_found', message: `虚拟模型 '${name}' 不存在` });
      return;
    }
    if (name === config.agent.defaultModel) {
      res.status(409).json({ error: 'default_model_in_use', message: '当前默认对话模型不能删除，请先通过 AGENT_DEFAULT_MODEL 更换默认模型' });
      return;
    }
    const referencedBy = (await ctx.store.listTenants())
      .filter((tenant) => tenant.models.includes(name))
      .map((tenant) => tenant.id);
    if (referencedBy.length) {
      res.status(409).json({
        error: 'model_in_use',
        message: `模型仍被租户 ${referencedBy.join('、')} 的白名单引用，请先移除引用`,
        tenants: referencedBy,
      });
      return;
    }
    await ctx.store.deleteVirtualModel(name);
    await auditAdmin(req, 'model.delete', { model: name });
    res.json({ data: { name, deleted: true } });
  });

  // 兼容已有 Agent 管理查询；写操作统一走 /v1/admin/models。
  router.get('/v1/admin/agents', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    res.json({ data: await ctx.router.listVirtualModels() });
  });

  // —— 自定义 Provider 连接配置
  router.get('/v1/admin/provider-definitions', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    res.json({ data: ctx.providers.describe() });
  });

  router.post('/v1/admin/provider-definitions', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    try {
      const parsed = parseProviderDefinition(req.body);
      if (parsed.name === 'tei' || ctx.providers.has(parsed.name)) {
        res.status(409).json({ error: 'provider_exists', message: `Provider '${parsed.name}' 已存在` });
        return;
      }
      const now = new Date().toISOString();
      const identity = requireIdentity(req);
      const definition = { ...parsed, createdAt: now, updatedAt: now, updatedBy: identity.userId };
      await ctx.providers.saveDefinition(definition);
      await auditAdmin(req, 'provider.create', { provider: definition });
      res.status(201).json({ data: ctx.providers.getDefinition(parsed.name) });
    } catch (err) {
      if (!(err instanceof ProviderConfigError)) throw err;
      res.status(400).json({ error: 'invalid_provider', message: err.message, issues: err.issues });
    }
  });

  router.put('/v1/admin/provider-definitions/:name', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    try {
      const name = String(req.params.name);
      const previous = ctx.providers.getDefinition(name);
      if (!previous || previous.source !== 'console') {
        res.status(400).json({ error: 'provider_managed_by_env', message: '内置 Provider 由环境变量管理，不能在控制台覆盖' });
        return;
      }
      const parsed = parseProviderDefinition(req.body, name);
      const removedAccounts = previous.accounts.filter((account) => !parsed.accounts.includes(account));
      if (removedAccounts.length) {
        const referencedBy = (await ctx.store.listVirtualModels())
          .filter((model) => model.targets.some((target) =>
            target.provider === name && removedAccounts.includes(target.account ?? 'default'),
          ))
          .map((model) => model.name);
        if (referencedBy.length) {
          res.status(409).json({ error: 'provider_account_in_use', message: `待移除账号仍被模型 ${referencedBy.join('、')} 引用，请先调整路由`, models: referencedBy });
          return;
        }
      }
      const identity = requireIdentity(req);
      const definition = {
        ...parsed,
        createdAt: previous.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: identity.userId,
      };
      await ctx.providers.saveDefinition(definition);
      for (const account of removedAccounts) await ctx.credentials.remove(name, account);
      await auditAdmin(req, 'provider.update', { provider: name, previous, current: definition, removedAccounts });
      res.json({ data: ctx.providers.getDefinition(name) });
    } catch (err) {
      if (!(err instanceof ProviderConfigError)) throw err;
      res.status(400).json({ error: 'invalid_provider', message: err.message, issues: err.issues });
    }
  });

  router.patch('/v1/admin/provider-definitions/:name', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'invalid_provider', message: 'enabled 必须为布尔值' });
      return;
    }
    const name = String(req.params.name);
    const previous = ctx.providers.getDefinition(name);
    if (!previous || previous.source !== 'console') {
      res.status(400).json({ error: 'provider_managed_by_env', message: '只有自定义 Provider 可以在控制台启停' });
      return;
    }
    const definition = await ctx.store.getProviderDefinition(name);
    if (!definition) {
      res.status(404).json({ error: 'provider_not_found', message: `Provider '${name}' 不存在` });
      return;
    }
    const updated = { ...definition, enabled: req.body.enabled as boolean, updatedAt: new Date().toISOString(), updatedBy: requireIdentity(req).userId };
    await ctx.providers.saveDefinition(updated);
    await auditAdmin(req, updated.enabled ? 'provider.enable' : 'provider.disable', { provider: name });
    res.json({ data: ctx.providers.getDefinition(name) });
  });

  router.delete('/v1/admin/provider-definitions/:name', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const name = String(req.params.name);
    const previous = ctx.providers.getDefinition(name);
    if (!previous || previous.source !== 'console') {
      res.status(400).json({ error: 'provider_managed_by_env', message: '内置 Provider 不能从控制台删除' });
      return;
    }
    const referencedBy = (await ctx.store.listVirtualModels())
      .filter((model) => model.targets.some((target) => target.provider === name))
      .map((model) => model.name);
    if (referencedBy.length) {
      res.status(409).json({ error: 'provider_in_use', message: `Provider 仍被模型 ${referencedBy.join('、')} 引用，请先调整路由`, models: referencedBy });
      return;
    }
    if (!(await ctx.providers.removeDefinition(name))) {
      res.status(404).json({ error: 'provider_not_found', message: `Provider '${name}' 不存在` });
      return;
    }
    let removedCredentials = 0;
    for (const account of previous.accounts) {
      if (await ctx.credentials.remove(name, account)) removedCredentials++;
    }
    await auditAdmin(req, 'provider.delete', { provider: name, removedCredentials });
    res.json({ data: { name, deleted: true, removedCredentials } });
  });

  router.post('/v1/admin/provider-definitions/:name/test', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const name = String(req.params.name);
    const account = String(req.body?.account ?? 'default');
    const provider = ctx.providers.getDefinition(name);
    if (!provider) {
      res.status(404).json({ error: 'provider_not_found', message: `Provider '${name}' 不存在` });
      return;
    }
    if (!provider.accounts.includes(account)) {
      res.status(400).json({ error: 'unknown_account', message: `Provider '${name}' 不存在账号 '${account}'` });
      return;
    }
    const result = await ctx.providers.test(name, account);
    await auditAdmin(req, 'provider.test', { provider: name, account, ok: result.ok, status: result.status, latencyMs: result.latencyMs });
    res.json({ data: result });
  });

  // —— 厂商凭证（控制台管理商业大模型 key，见 4.4 Key 治理 / 8.5 凭证安全）
  //
  // 读：任意已登录用户可见，但**只返回掩码** —— 明文永不回传浏览器。
  // 写/删：仅 admin / platform-admin，且每次变更都写审计（Key 轮换全记录）。
  router.get('/v1/admin/providers', async (_req: Request, res: Response) => {
    res.json({
      data: ctx.credentials.list(),
      // 主密钥没配时禁止写入 —— 界面据此禁用输入框并给出原因
      masterKeyConfigured: !!config.gateway.credentialMasterKey,
    });
  });

  router.put('/v1/admin/providers/:provider', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const identity = requireIdentity(req);
    const provider = String(req.params.provider ?? '').trim();
    const account = String(req.body?.account ?? 'default').trim();
    const apiKey = String(req.body?.apiKey ?? '').trim();

    if (!provider || !apiKey) {
      res.status(400).json({ error: 'invalid_request', message: 'provider 与 apiKey 均为必填' });
      return;
    }
    const definition = ctx.providers.getDefinition(provider);
    if (!definition || !definition.accounts.includes(account)) {
      res.status(400).json({
        error: 'unknown_provider_account',
        message: `未知 Provider 或账号：${provider}/${account}`,
        allowed: ctx.providers.describe().map((item) => ({ provider: item.name, accounts: item.accounts })),
      });
      return;
    }

    try {
      const view = await ctx.credentials.set(provider, apiKey, identity.userId, account);
      // 审计只记掩码 —— 明文绝不能进审计流水
      await auditAdmin(req, 'provider.credential.set', {
        provider,
        account,
        masked: view.masked,
        source: view.source,
      });
      res.json({ data: view });
    } catch (err) {
      const status = err instanceof CredentialError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      await auditAdmin(req, 'provider.credential.set', { provider, account, error: message }, 'error');
      res.status(status).json({ error: 'credential_write_failed', message });
    }
  });

  router.delete('/v1/admin/providers/:provider', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const provider = String(req.params.provider ?? '').trim();
    const account = String(req.query.account ?? 'default').trim();
    const definition = ctx.providers.getDefinition(provider);
    if (!definition || !definition.accounts.includes(account)) {
      res.status(400).json({ error: 'unknown_provider_account', message: `未知 Provider 或账号：${provider}/${account}` });
      return;
    }
    const removed = await ctx.credentials.remove(provider, account);
    // 删除后回落到环境变量 / OAuth 凭证文件 —— 审计要记回落来源
    const view = ctx.credentials.view(account === 'default' ? provider : `${provider}#${account}`);
    await auditAdmin(req, 'provider.credential.delete', {
      provider,
      account,
      removed,
      fallbackSource: view.source,
    });
    res.json({ data: view, removed });
  });

  // —— HITL 审批
  router.get('/v1/admin/approvals', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const list = await ctx.store.listApprovals({
      tenantId: identity.tenantId,
      status: req.query.status as string | undefined,
      // 审批角色看本租户全部；普通用户只看自己发起的工单。
      // 对话页据此展示只读等待状态，审批操作仍由 decide 接口单独授权。
      userId: APPROVER_ROLES.has(identity.role)
        ? (req.query.user_id as string | undefined)
        : identity.userId,
    });
    res.json({ data: list });
  });

  router.post('/v1/admin/approvals/:id/decide', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const id = String(req.params.id);
    const decision = String(req.body?.decision ?? '');
    if (!['approved', 'rejected'].includes(decision)) {
      res.status(400).json({ error: 'decision 必须为 approved 或 rejected' });
      return;
    }
    // 审批权限：仅管理员 / 主管，且不得审批自己发起的申请
    if (!APPROVER_ROLES.has(identity.role)) {
      res.status(403).json({ error: 'forbidden', message: `当前角色 ${identity.role} 无审批权限` });
      return;
    }
    const approval = await ctx.store.getApproval(id);
    if (!approval) {
      res.status(404).json({ error: '审批单不存在' });
      return;
    }
    if (approval.tenantId !== identity.tenantId) {
      res.status(404).json({ error: '审批单不存在' });
      return;
    }
    if (approval.userId === identity.userId) {
      res.status(403).json({ error: 'forbidden', message: '不得审批自己发起的申请' });
      return;
    }
    if (approval.status !== 'pending') {
      res.status(409).json({ error: 'approval_already_decided', message: `审批单当前状态为 ${approval.status}` });
      return;
    }
    const transitioned = await ctx.store.transitionApproval(id, identity.tenantId, 'pending', {
      status: decision as 'approved' | 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: identity.userId,
    });
    if (!transitioned) {
      res.status(409).json({ error: 'approval_already_decided', message: '审批单已被其他审批人处理' });
      return;
    }
    await auditAdmin(req, `approval.${decision}`, { approvalId: id, tool: approval.tool });

    // 知识库写操作：审批通过后才真正落库（见 routes/knowledge.ts 的写操作说明）
    let executed: { ok: boolean; message: string } | undefined;
    if (decision === 'approved' && (approval.tool === KB_UPSERT_TOOL || approval.tool === KB_DELETE_TOOL)) {
      executed = await executeApprovedKnowledgeWrite(ctx, approval, identity.userId);
      await auditAdmin(req, executed.ok ? 'knowledge.write.executed' : 'knowledge.write.failed', {
        approvalId: id,
        tool: approval.tool,
        ok: executed.ok,
        message: executed.message,
      });
    }

    res.json({
      data: await ctx.store.getApproval(id),
      ...(executed ? { executed } : {}),
    });
  });

  // —— Trace
  router.get('/v1/admin/traces', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const identity = requireIdentity(req);
    const tenantId =
      identity.role === 'platform-admin'
        ? (req.query.tenant_id as string | undefined)
        : identity.tenantId;
    res.json({ data: await ctx.store.listTraces({ tenantId, limit: Number(req.query.limit ?? 100) }) });
  });

  // —— Keycloak 人员用户与权限（仅平台管理员；身份数据以 Keycloak 为准）
  // 说明：这些路由必须用 asyncHandler 包起来 —— Express 4 不会接管 async
  // handler 抛出的 rejected promise，未包装时请求会一直挂起，且 Node ≥15
  // 默认让网关进程直接退出。
  router.get('/v1/admin/users', asyncHandler(async (req: Request, res: Response) => {
    if (!assertPlatformAdmin(req, res)) return;
    try {
      res.json({ data: await ctx.userAdmin.list() });
    } catch (err) {
      await handleUserError(req, res, 'user.list', {}, err);
    }
  }));

  router.post('/v1/admin/users', asyncHandler(async (req: Request, res: Response) => {
    if (!assertPlatformAdmin(req, res)) return;
    const input = userInput(req.body ?? {});
    try {
      await assertTenantAvailable(input.tenantId);
      const result = await ctx.userAdmin.create(input);
      await auditAdmin(req, 'user.create', {
        userId: result.user.id,
        username: result.user.username,
        role: result.user.role,
        tenantId: result.user.tenantId,
        deptId: result.user.deptId,
        sensitivity: result.user.sensitivity,
      });
      res.status(201).json({ data: result.user, password: result.password });
    } catch (err) {
      await handleUserError(req, res, 'user.create', { username: input.username, tenantId: input.tenantId }, err);
    }
  }));

  router.put('/v1/admin/users/:id', asyncHandler(async (req: Request, res: Response) => {
    if (!assertPlatformAdmin(req, res)) return;
    const id = String(req.params.id);
    const actor = requireIdentity(req);
    try {
      const target = await ctx.userAdmin.get(id);
      const input = userInput(req.body ?? {}, target.username);
      await assertTenantAvailable(input.tenantId);
      if (id === actor.userId && (input.role !== target.role || input.tenantId !== target.tenantId)) {
        throw new KeycloakUserError(409, 'self_privilege_change', '不能修改自己的平台角色或所属租户');
      }
      if (input.role !== target.role) await assertNotLastPlatformAdmin(target);
      const update: ManagedUserUpdate = {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        tenantId: input.tenantId,
        deptId: input.deptId,
        sensitivity: input.sensitivity,
      };
      const emailChanged = target.email.toLowerCase() !== update.email.toLowerCase();
      const result = await ctx.userAdmin.update(id, update);
      await auditAdmin(req, 'user.update', {
        userId: id,
        username: target.username,
        before: { email: target.email, role: target.role, tenantId: target.tenantId, deptId: target.deptId, sensitivity: target.sensitivity },
        after: update,
        emailChanged,
        sessionRevoked: result.sessionRevoked,
      });
      res.json({ data: result.user, sessionRevoked: result.sessionRevoked });
    } catch (err) {
      await handleUserError(req, res, 'user.update', { userId: id }, err);
    }
  }));

  router.patch('/v1/admin/users/:id', asyncHandler(async (req: Request, res: Response) => {
    if (!assertPlatformAdmin(req, res)) return;
    const id = String(req.params.id);
    const actor = requireIdentity(req);
    const enabled = req.body?.enabled;
    try {
      if (typeof enabled !== 'boolean') {
        throw new KeycloakUserError(400, 'invalid_enabled', 'enabled 必须是布尔值');
      }
      const target = await ctx.userAdmin.get(id);
      if (id === actor.userId && !enabled) {
        throw new KeycloakUserError(409, 'self_disable', '不能停用当前登录账号');
      }
      if (!enabled) await assertNotLastPlatformAdmin(target);
      const result = await ctx.userAdmin.setEnabled(id, enabled);
      await auditAdmin(req, enabled ? 'user.enable' : 'user.disable', {
        userId: id,
        username: target.username,
        sessionRevoked: result.sessionRevoked,
      });
      res.json({ data: result.user, sessionRevoked: result.sessionRevoked });
    } catch (err) {
      await handleUserError(req, res, enabled ? 'user.enable' : 'user.disable', { userId: id }, err);
    }
  }));

  router.post('/v1/admin/users/:id/reset-password', asyncHandler(async (req: Request, res: Response) => {
    if (!assertPlatformAdmin(req, res)) return;
    const id = String(req.params.id);
    try {
      const target = await ctx.userAdmin.get(id);
      const result = await ctx.userAdmin.resetPassword(id);
      await auditAdmin(req, 'user.password.reset', { userId: id, username: target.username, sessionRevoked: result.sessionRevoked });
      res.json({ data: target, password: result.password, sessionRevoked: result.sessionRevoked });
    } catch (err) {
      await handleUserError(req, res, 'user.password.reset', { userId: id }, err);
    }
  }));

  router.delete('/v1/admin/users/:id', asyncHandler(async (req: Request, res: Response) => {
    if (!assertPlatformAdmin(req, res)) return;
    const id = String(req.params.id);
    const actor = requireIdentity(req);
    try {
      const target = await ctx.userAdmin.get(id);
      if (id === actor.userId) {
        throw new KeycloakUserError(409, 'self_delete', '不能删除当前登录账号');
      }
      await assertNotLastPlatformAdmin(target);
      await ctx.userAdmin.remove(id);
      await auditAdmin(req, 'user.delete', {
        userId: target.id,
        username: target.username,
        role: target.role,
        tenantId: target.tenantId,
      });
      res.json({ data: target });
    } catch (err) {
      await handleUserError(req, res, 'user.delete', { userId: id }, err);
    }
  }));

  // —— 健康与指标（见 11.1 监控：网关内置 metrics 端点，临时抓取排查）
  router.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'agentgateway', ts: new Date().toISOString() });
  });

  router.get('/metrics', async (req: Request, res: Response) => {
    if (!assertAdmin(req, res)) return;
    const month = new Date().toISOString().slice(0, 7);
    const platform = await ctx.store.getUsage('platform', config.platformId, month);
    res.type('text/plain').send(
      [
        '# HELP eap_requests_total 本月平台请求总数',
        `# TYPE eap_requests_total counter`,
        `eap_requests_total ${platform.requests}`,
        '# HELP eap_prompt_tokens_total 本月输入 token 总数',
        `# TYPE eap_prompt_tokens_total counter`,
        `eap_prompt_tokens_total ${platform.promptTokens}`,
        '# HELP eap_completion_tokens_total 本月输出 token 总数',
        `# TYPE eap_completion_tokens_total counter`,
        `eap_completion_tokens_total ${platform.completionTokens}`,
        '# HELP eap_cost_usd_total 本月成本（USD）',
        `# TYPE eap_cost_usd_total counter`,
        `eap_cost_usd_total ${platform.costUsd}`,
      ].join('\n'),
    );
  });

  return router;
}
