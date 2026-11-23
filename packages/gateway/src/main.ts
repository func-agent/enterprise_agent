/**
 * agentgateway 入口（见 3.1 网关组件：LLM 路由 + MCP 治理 + Guardrails + 预算）。
 *
 * 启动时初始化默认租户、应用与演示知识库数据，保证开箱可用。
 */
import { config, createLogger, uuid } from '@eap/platform-core';
import { createContext } from './context.js';
import { createServer } from './server.js';
import { assertEgressProxyConfigured } from './llm/egress.js';

const log = createLogger('gateway:main');

const DEMO_DOCS = [
  {
    id: 'doc-policy-leave',
    deptId: 'dept-general',
    sensitivity: 'internal' as const,
    title: '员工年假管理制度',
    content:
      '员工入职满 1 年可享受 5 天带薪年假，满 3 年 10 天，满 5 年 15 天。年假需提前 3 个工作日在 OA 系统提交申请，连续请假超过 5 天需部门负责人及人力资源部审批。年假原则上应在当年度使用完毕，未使用部分最多结转 3 天至次年第一季度。',
  },
  {
    id: 'doc-policy-expense',
    deptId: 'dept-general',
    sensitivity: 'internal' as const,
    title: '差旅费报销管理办法',
    content:
      '国内出差住宿标准：一线城市每晚 600 元，二线城市 450 元，其他城市 350 元。市内交通费实报实销，需提供行程单。单笔超过 5000 元的报销单须经财务总监审批。报销需在出差结束后 30 日内提交，逾期不予受理。',
  },
  {
    id: 'doc-contract-huadong',
    deptId: 'dept-east',
    sensitivity: 'confidential' as const,
    title: '华东区年度采购框架协议（要点）',
    content:
      '本协议有效期为 2024-01-01 至 2024-12-31。年度采购总额不超过 1200 万元。乙方应保证交付周期不超过 45 天，逾期违约金为合同金额的 3%。甲方有权在季度评审中要求调整采购量，调整幅度不超过 20%。',
  },
  {
    id: 'doc-metric-sales',
    deptId: 'dept-general',
    sensitivity: 'internal' as const,
    title: '销售指标口径说明',
    content:
      '销售额存在三种口径：下单口径（按 order_date 统计，不含退款）、开票口径（按 invoice_date 统计，含税）、回款口径（按 payment_date 统计实收）。跨部门沟通时必须先明确使用哪一种口径，避免同一问题出现三个答案。默认口径为下单口径。',
  },
];

async function main() {
  // 9.3 网络要求：生产环境商业 API 出网必须经 Envoy 唯一出口，漏配则拒绝启动
  assertEgressProxyConfigured();

  const ctx = await createContext();

  // 默认租户（首期单租户 + 部门隔离，见 7.3）
  const defaultTenantId = config.auth.defaultTenantId;
  const existing = await ctx.store.getTenant(defaultTenantId);
  if (!existing) {
    await ctx.store.upsertTenant({
      id: defaultTenantId,
      name: '默认租户',
      models: [],
      tools: [],
      knowledgeBases: ['default'],
      monthlyBudgetUsd: 100,
      monthlyTokenBudget: 20_000_000,
      enabled: true,
    });
    log.info('已创建默认租户', { tenantId: defaultTenantId });
  }

  // 默认应用（应用级预算与限流的载体）
  const apps = await ctx.store.listApplications(defaultTenantId);
  if (!apps.some((a) => a.id === 'app-default')) {
    await ctx.store.upsertApplication({
      id: 'app-default',
      tenantId: defaultTenantId,
      name: '默认应用',
      qpsLimit: 20,
      perRequestTokenLimit: 32000,
      monthlyBudgetUsd: 50,
      enabled: true,
    });
  }

  // 演示知识库数据
  const docs = await ctx.store.listKnowledgeDocs(defaultTenantId);
  if (docs.length === 0) {
    for (const d of DEMO_DOCS) {
      await ctx.store.upsertKnowledgeDoc({
        ...d,
        tenantId: defaultTenantId,
        ownerId: 'system',
        updatedAt: new Date().toISOString(),
      });
    }
    log.info('已写入演示知识库文档', { count: DEMO_DOCS.length });
  }

  const app = createServer(ctx);
  app.listen(config.gateway.port, config.gateway.host, () => {
    log.info('agentgateway 已启动', {
      url: `http://${config.gateway.host}:${config.gateway.port}`,
      openaiBaseUrl: config.gateway.openaiBaseUrl,
      providers: ctx.providers.list(),
    });
  });

  const shutdown = async () => {
    log.info('正在关闭 agentgateway');
    await ctx.clients.closeAll();
    ctx.providers.stop();
    await ctx.credentials.stop();
    await ctx.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 进程级兜底：Node ≥15 对未处理 rejection 默认是 throw，会直接终结网关进程。
  // 路由层已用 asyncHandler 把异步异常交给全局错误中间件，这里只兜住
  // 漏网的 rejection（第三方回调、定时任务等），记日志后继续服务，
  // 避免一次偶发异常把整个平台的 LLM 网关带下线。
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise rejection', { error: String((reason as Error)?.stack ?? reason) });
  });
}

main().catch((err) => {
  log.error('网关启动失败', { error: String(err?.stack ?? err) });
  process.exit(1);
});
