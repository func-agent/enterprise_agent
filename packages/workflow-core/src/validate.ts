/**
 * DAG 校验器 —— 见设计文档 5.3、R3、R4、R8。
 *
 * 纯函数：输入定义 + 校验上下文，输出问题列表。
 * 发布时与每次运行前都会执行，**已发布版本也必须重新校验**，不能只信任发布时的结果。
 */
import { collectConditionRefs, validateConditionExpression } from './condition.js';
import { PLATFORM_LIMIT_CAPS, STRUCTURE_LIMITS, effectiveLimitCap } from './limits.js';
import { NODE_ID_PATTERN, ancestorsOf, collectRefs, ownEntry, parseRef } from './refs.js';
import { FORBIDDEN_PROPERTY_KEYS, checkSchemaSchema } from './schema.js';
import { topologicalOrder } from './topology.js';
import {
  NODE_BRANCH_VALUES,
  SUPPORTED_NODE_IMPLEMENTATIONS,
  SUPPORTED_SCHEMA_VERSIONS,
  type JsonSchema,
  type ResourceCheckStatus,
  type ResourceCheckSummary,
  type TemplatedValue,
  type ValidationContext,
  type ValidationIssue,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowLimits,
  type WorkflowNode,
  type WorkflowNodeType,
} from './types.js';

const NODE_TYPES = Object.keys(SUPPORTED_NODE_IMPLEMENTATIONS) as WorkflowNodeType[];
const LIMIT_KEYS: (keyof WorkflowLimits)[] = [
  'maxSteps',
  'maxLlmCalls',
  'maxToolCalls',
  'timeoutMs',
  'approvalTimeoutMs',
];
const MAX_CONFIG_DEPTH = STRUCTURE_LIMITS.maxConfigDepth;
const textEncoder = new TextEncoder();

/** 工具标识格式：`serverId/tool`。 */
const TOOL_REF_PATTERN = /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/;

const CONFIG_KEYS: Record<WorkflowNodeType, readonly string[]> = Object.assign(
  Object.create(null) as Record<WorkflowNodeType, readonly string[]>,
  {
    input: ['fields'],
    llm: ['model', 'systemPrompt', 'userPrompt', 'maxOutputTokens'],
    knowledge: ['query', 'topK', 'knowledgeScope'],
    tool: ['serverId', 'tool', 'args'],
    condition: ['condition'],
    agent: ['model', 'instruction', 'maxIterations', 'allowedTools'],
    approval: ['title', 'description', 'summary'],
    output: ['fields'],
  },
);

const BUILTIN_OUTPUT_PROPERTIES: Partial<Record<WorkflowNodeType, Record<string, JsonSchema>>> = Object.assign(
  Object.create(null) as Partial<Record<WorkflowNodeType, Record<string, JsonSchema>>>,
  {
    llm: {
      text: { type: 'string' },
      structured: {},
      promptTokens: { type: 'integer', minimum: 0 },
      completionTokens: { type: 'integer', minimum: 0 },
      model: { type: 'string' },
      traceId: { type: 'string' },
    },
    knowledge: {
      text: { type: 'string' },
      sources: { type: 'array' },
    },
    tool: {
      ok: { type: 'boolean' },
      content: {},
      structured: {},
      reason: {},
      traceId: { type: 'string' },
    },
    agent: {
      content: { type: 'string' },
      toolCalls: { type: 'array' },
      traceId: { type: 'string' },
    },
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function issue(
  code: string,
  message: string,
  extra: { nodeId?: string; edgeId?: string; path?: string } = {},
): ValidationIssue {
  return { code, message, ...extra };
}

/** 拓扑排序由 topology.ts 统一提供，校验器与执行器共用同一稳定顺序。 */

function reachableFrom(nodeIds: string[], edges: WorkflowEdge[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const seen = new Set<string>();
  const stack = [...nodeIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of outgoing.get(id) ?? []) stack.push(next);
  }
  return seen;
}

function canReach(targets: string[], edges: WorkflowEdge[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  const seen = new Set<string>();
  const stack = [...targets];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const prev of incoming.get(id) ?? []) stack.push(prev);
  }
  return seen;
}

function validateSchema(
  schema: unknown,
  path: string,
  issues: ValidationIssue[],
  nodeId?: string,
): void {
  if (schema === undefined) return;
  const result = checkSchemaSchema(schema);
  for (const error of result.errors) {
    issues.push(issue('invalid_schema', error, { nodeId, path }));
  }
  try {
    const serialized = JSON.stringify(schema) ?? '';
    if (textEncoder.encode(serialized).byteLength > STRUCTURE_LIMITS.maxSchemaBytes) {
      issues.push(issue('schema_too_large', `Schema 超过体积上限 ${STRUCTURE_LIMITS.maxSchemaBytes} 字节`, { nodeId, path }));
    }
  } catch {
    issues.push(issue('invalid_schema', 'Schema 必须是可序列化的 JSON', { nodeId, path }));
  }
}

function requiredString(
  config: Record<string, unknown>,
  key: string,
  node: WorkflowNode,
  issues: ValidationIssue[],
): string | undefined {
  const value = config[key];
  const path = `nodes.${node.id}.config.${key}`;
  if (value === undefined || value === null || value === '') {
    issues.push(issue('missing_config', `节点缺少必填配置 ${key}`, { nodeId: node.id, path }));
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(issue('invalid_config', `${key} 必须是非空字符串`, { nodeId: node.id, path }));
    return undefined;
  }
  return value;
}

function validateConfigValue(
  value: unknown,
  path: string,
  nodeId: string,
  issues: ValidationIssue[],
  depth = 0,
  forbidCtx = false,
): void {
  if (depth > MAX_CONFIG_DEPTH) {
    issues.push(issue('config_too_deep', `配置嵌套深度不能超过 ${MAX_CONFIG_DEPTH}`, { nodeId, path }));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateConfigValue(item, `${path}[${index}]`, nodeId, issues, depth + 1, forbidCtx));
    return;
  }
  if (!isRecord(value)) return;
  if (hasOwn(value, '$ref')) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string') {
      issues.push(issue('invalid_ref', '引用对象只能包含字符串类型的 $ref 字段', { nodeId, path }));
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    // 原型污染键：写进普通对象会触发原型 setter，注入的属性下游读得到、序列化又看不见。
    if (FORBIDDEN_PROPERTY_KEYS.includes(key)) {
      issues.push(issue('invalid_config', `不允许使用会造成原型污染的键名：${key}`, {
        nodeId, path: `${path}.${key}`,
      }));
      continue;
    }
    // 网关注入的 __ctx 不允许被覆盖，任意层级都不允许。
    if (forbidCtx && key === '__ctx') {
      issues.push(issue('ctx_override_forbidden', '工具参数不允许覆盖 __ctx', {
        nodeId, path: `${path}.${key}`,
      }));
      continue;
    }
    validateConfigValue(item, `${path}.${key}`, nodeId, issues, depth + 1, forbidCtx);
  }
}

function validateNodeConfig(
  node: WorkflowNode,
  definition: WorkflowDefinition,
  issues: ValidationIssue[],
): void {
  const rawConfig = node.config === undefined ? {} : node.config;
  const config = isRecord(rawConfig) ? rawConfig : {};
  if (!isRecord(rawConfig)) {
    issues.push(issue('invalid_config', '节点配置必须是对象', {
      nodeId: node.id,
      path: `nodes.${node.id}.config`,
    }));
  }

  for (const key of Object.keys(config)) {
    const allowedKeys = ownEntry(CONFIG_KEYS, node.type);
    if (allowedKeys && !allowedKeys.includes(key)) {
      issues.push(issue('invalid_config', `不支持的节点配置字段 ${key}`, {
        nodeId: node.id,
        path: `nodes.${node.id}.config.${key}`,
      }));
    }
  }

  if (node.type === 'llm' || node.type === 'agent') {
    const model = requiredString(config, 'model', node, issues);
    if (model && model.length > 128) {
      issues.push(issue('invalid_model', '虚拟模型名过长', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.model`,
      }));
    }
  }

  if (node.type === 'llm') {
    const maxTokens = config.maxOutputTokens;
    if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
      issues.push(issue('invalid_config', 'maxOutputTokens 必须是正整数', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.maxOutputTokens`,
      }));
    }
    for (const key of ['systemPrompt', 'userPrompt'] as const) {
      const prompt = config[key];
      if (prompt === undefined) continue;
      const path = `nodes.${node.id}.config.${key}`;
      if (typeof prompt === 'string') {
        if (prompt.length > STRUCTURE_LIMITS.maxPromptChars) {
          issues.push(issue('prompt_too_long', `${key} 超过长度上限 ${STRUCTURE_LIMITS.maxPromptChars}`, { nodeId: node.id, path }));
        }
        continue;
      }
      if (!Array.isArray(prompt)) {
        issues.push(issue('invalid_config', `${key} 必须是字符串或片段数组`, { nodeId: node.id, path }));
        continue;
      }
      let total = 0;
      for (const fragment of prompt) {
        if (typeof fragment === 'string') {
          total += fragment.length;
          continue;
        }
        if (isRecord(fragment) && typeof fragment.$ref === 'string') continue;
        issues.push(issue('invalid_config', `${key} 的片段必须是字符串或引用`, { nodeId: node.id, path }));
      }
      if (total > STRUCTURE_LIMITS.maxPromptChars) {
        issues.push(issue('prompt_too_long', `${key} 超过长度上限 ${STRUCTURE_LIMITS.maxPromptChars}`, { nodeId: node.id, path }));
      }
    }
  }

  if (node.type === 'knowledge') {
    const query = config.query;
    if (query === undefined || query === null || query === '') {
      issues.push(issue('missing_config', '节点缺少必填配置 query', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.query`,
      }));
    } else if (typeof query !== 'string' && !(isRecord(query) && typeof query.$ref === 'string')) {
      issues.push(issue('invalid_config', 'query 必须是字符串或引用', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.query`,
      }));
    }
    const topK = config.topK;
    if (topK !== undefined && (typeof topK !== 'number' || !Number.isInteger(topK) || topK <= 0 || topK > 100)) {
      issues.push(issue('invalid_config', 'topK 必须是 1–100 的整数', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.topK`,
      }));
    }
    const scope = config.knowledgeScope;
    if (scope !== undefined && (typeof scope !== 'string' || scope.trim().length === 0 || scope.length > 128)) {
      issues.push(issue('invalid_config', 'knowledgeScope 必须是长度不超过 128 的非空字符串', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.knowledgeScope`,
      }));
    }
  }

  if (node.type === 'tool') {
    const serverId = requiredString(config, 'serverId', node, issues);
    const toolName = requiredString(config, 'tool', node, issues);
    for (const [key, value] of [['serverId', serverId], ['tool', toolName]] as const) {
      if (value && value.length > 128) {
        issues.push(issue('invalid_config', `${key} 长度不能超过 128`, {
          nodeId: node.id,
          path: `nodes.${node.id}.config.${key}`,
        }));
      }
    }
    if (serverId && toolName && !TOOL_REF_PATTERN.test(`${serverId}/${toolName}`)) {
      issues.push(issue('invalid_config', '工具标识必须是 serverId/tool 格式，且两段都不能包含空白或斜杠', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.tool`,
      }));
    }
    const args = config.args;
    if (args !== undefined && !isRecord(args)) {
      issues.push(issue('invalid_config', 'args 必须是对象', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.args`,
      }));
    }
    // `__ctx` 的禁止覆盖在 validateConfigValue 里按层级统一检查（下面 forbidCtx），
    // 顶层与嵌套一视同仁，避免只拦一层。
  }

  if (node.type === 'agent') {
    const instruction = config.instruction;
    if (instruction !== undefined && typeof instruction !== 'string') {
      issues.push(issue('invalid_config', 'instruction 必须是字符串', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.instruction`,
      }));
    } else if (typeof instruction === 'string' && instruction.length > STRUCTURE_LIMITS.maxPromptChars) {
      issues.push(issue('prompt_too_long', `instruction 超过长度上限 ${STRUCTURE_LIMITS.maxPromptChars}`, {
        nodeId: node.id,
        path: `nodes.${node.id}.config.instruction`,
      }));
    }
    const iterations = config.maxIterations;
    if (iterations !== undefined && (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations <= 0)) {
      issues.push(issue('invalid_config', 'maxIterations 必须是正整数', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.maxIterations`,
      }));
    }
    if (config.allowedTools !== undefined) {
      if (!Array.isArray(config.allowedTools) || config.allowedTools.some((tool) => typeof tool !== 'string' || tool.trim().length === 0)) {
        issues.push(issue('invalid_config', 'allowedTools 必须是非空字符串组成的数组', {
          nodeId: node.id,
          path: `nodes.${node.id}.config.allowedTools`,
        }));
      } else {
        // 工具标识统一为 `serverId/tool`，与工具节点和资源白名单的口径一致。
        for (const tool of config.allowedTools) {
          if (typeof tool === 'string' && !TOOL_REF_PATTERN.test(tool)) {
            issues.push(issue('invalid_config', `allowedTools 必须是 serverId/tool 格式：${tool}`, {
              nodeId: node.id,
              path: `nodes.${node.id}.config.allowedTools`,
            }));
          }
        }
      }
    }
  }

  if (node.type === 'condition') {
    const expr = config.condition;
    if (expr === undefined || expr === null) {
      issues.push(issue('missing_config', '条件节点必须配置 condition', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.condition`,
      }));
    } else {
      for (const item of validateConditionExpression(expr, `nodes.${node.id}.config.condition`)) {
        issues.push({ ...item, nodeId: node.id });
      }
    }
  }

  if (node.type === 'input') {
    // 输入节点必须声明表单字段：缺省时表单为空，同样覆盖不了必填字段，
    // 规则不能因为少写一个键就被整体架空。
    if (config.fields === undefined) {
      issues.push(issue('invalid_config', '输入节点必须声明表单字段 config.fields', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.fields`,
      }));
    } else if (!Array.isArray(config.fields) || config.fields.some((field) => typeof field !== 'string' || field.length === 0)) {
      issues.push(issue('invalid_config', 'fields 必须是非空字符串组成的数组', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.fields`,
      }));
    } else {
      const properties = isRecord(definition.inputSchema) && isRecord(definition.inputSchema.properties)
        ? definition.inputSchema.properties
        : {};
      for (const field of config.fields) {
        if (!hasOwn(properties, field)) {
          issues.push(issue('invalid_config', `输入表单字段未在 inputSchema 中声明：${field}`, {
            nodeId: node.id,
            path: `nodes.${node.id}.config.fields`,
          }));
        }
      }
      // 表单必须覆盖 inputSchema.required：否则用户填不到必填字段，
      // 运行期校验必然失败，而失败点会晚到启动运行才暴露。
      const required = isRecord(definition.inputSchema) && Array.isArray(definition.inputSchema.required)
        ? definition.inputSchema.required.filter((field): field is string => typeof field === 'string')
        : [];
      for (const field of required) {
        if (!config.fields.includes(field)) {
          issues.push(issue('invalid_config', `输入表单未覆盖 inputSchema 的必填字段：${field}`, {
            nodeId: node.id,
            path: `nodes.${node.id}.config.fields`,
          }));
        }
      }
    }
  }

  if (node.type === 'output') {
    if (config.fields !== undefined && !isRecord(config.fields)) {
      issues.push(issue('invalid_config', '输出 fields 必须是对象', {
        nodeId: node.id,
        path: `nodes.${node.id}.config.fields`,
      }));
    }
    // 输出节点声明了 outputSchema 时，表单字段必须覆盖它的必填项：
    // 否则发布期放行、运行期才以 invalid_output 失败，与输入节点的规则不对称。
    const outputSchema = isRecord(node.outputSchema) ? node.outputSchema : undefined;
    const required = outputSchema && Array.isArray(outputSchema.required)
      ? outputSchema.required.filter((field): field is string => typeof field === 'string')
      : [];
    const fields = isRecord(config.fields) ? Object.keys(config.fields) : [];
    for (const field of required) {
      if (!fields.includes(field)) {
        issues.push(issue('invalid_config', `输出表单未覆盖 outputSchema 的必填字段：${field}`, {
          nodeId: node.id,
          path: `nodes.${node.id}.config.fields`,
        }));
      }
    }
  }

  if (node.type === 'approval') {
    for (const key of ['title', 'description'] as const) {
      if (config[key] !== undefined && typeof config[key] !== 'string') {
        issues.push(issue('invalid_config', `${key} 必须是字符串`, {
          nodeId: node.id,
          path: `nodes.${node.id}.config.${key}`,
        }));
      }
    }
  }

  for (const [key, value] of Object.entries(config)) {
    if (node.type === 'condition' && key === 'condition') continue;
    // 工具节点整棵参数树都禁止覆盖 __ctx。
    validateConfigValue(value, `nodes.${node.id}.config.${key}`, node.id, issues, 0, node.type === 'tool');
  }
  validateSchema(node.inputSchema, `nodes.${node.id}.inputSchema`, issues, node.id);
  validateSchema(node.outputSchema, `nodes.${node.id}.outputSchema`, issues, node.id);
  if (isRecord(node.outputSchema) && node.outputSchema.type !== 'object') {
    issues.push(issue('invalid_schema', '节点输出 Schema 根类型必须显式声明为 object', {
      nodeId: node.id,
      path: `nodes.${node.id}.outputSchema.type`,
    }));
  }
  validateOutputFieldConstraints(node, definition, issues);
}

function schemaBound(
  schema: JsonSchema,
  key: 'minimum' | 'maximum' | 'minLength' | 'maxLength',
): number | undefined {
  const value = schema[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mergedBound(
  builtIn: JsonSchema,
  custom: JsonSchema,
  key: 'minimum' | 'maximum' | 'minLength' | 'maxLength',
): number | undefined {
  const builtInValue = schemaBound(builtIn, key);
  const customValue = schemaBound(custom, key);
  if (builtInValue === undefined) return customValue;
  if (customValue === undefined) return builtInValue;
  return key === 'minimum' || key === 'minLength'
    ? Math.max(builtInValue, customValue)
    : Math.min(builtInValue, customValue);
}

/**
 * 取出 Schema 里的字符串数组；形态非法时返回空数组。
 *
 * `required` 来自用户提交的 DAG JSON，是不可信输入：
 * 非数组形态（数字、布尔）直接展开会抛 TypeError，
 * 字符串形态还会被逐字符展开成 ['r','i','s','k']，把非法约束变成一条看着合法的假约束。
 * 形态是否合法由 checkSchemaSchema 统一判定并报 invalid_schema，
 * 这里只负责「不炸」——校验器不能变成异常入口（见设计文档 13）。
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 取出 Schema 里的取值数组；形态非法时返回空数组。
 *
 * 与 stringList 的区别：enum 的合法取值不限于字符串（数字、布尔都是合法枚举值），
 * 所以这里保留原始元素，只判定「是不是数组」。
 */
function valueList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 递归合并 Schema；同名字段的自定义约束只能收紧，不能覆盖内置底线。 */
function mergeOutputSchema(builtIn: JsonSchema, custom: JsonSchema): JsonSchema {
  const merged: JsonSchema = { ...builtIn, ...custom };
  if (builtIn.type !== undefined) merged.type = builtIn.type;

  const minimum = mergedBound(builtIn, custom, 'minimum');
  const maximum = mergedBound(builtIn, custom, 'maximum');
  const minLength = mergedBound(builtIn, custom, 'minLength');
  const maxLength = mergedBound(builtIn, custom, 'maxLength');
  if (minimum === undefined) delete merged.minimum;
  else merged.minimum = minimum;
  if (maximum === undefined) delete merged.maximum;
  else merged.maximum = maximum;
  if (minLength === undefined) delete merged.minLength;
  else merged.minLength = minLength;
  if (maxLength === undefined) delete merged.maxLength;
  else merged.maxLength = maxLength;

  // required 形态非法时按「无必填字段」合并：真实形态错误由 checkSchemaSchema 报 invalid_schema，
  // 合并阶段只负责不把非法输入展开成假约束。
  if (builtIn.required !== undefined || custom.required !== undefined) {
    merged.required = [...new Set([...stringList(builtIn.required), ...stringList(custom.required)])];
  }
  if (builtIn.properties !== undefined || custom.properties !== undefined) {
    const customProperties = custom.properties ?? {};
    const properties: Record<string, JsonSchema> = { ...customProperties };
    for (const [key, builtInProperty] of Object.entries(builtIn.properties ?? {})) {
      const customProperty = customProperties[key];
      properties[key] = isRecord(customProperty)
        ? mergeOutputSchema(builtInProperty, customProperty as JsonSchema)
        : builtInProperty;
    }
    merged.properties = properties;
  }
  if (builtIn.items !== undefined && custom.items !== undefined) {
    merged.items = mergeOutputSchema(builtIn.items, custom.items);
  }
  if (builtIn.enum !== undefined && custom.enum !== undefined) {
    const customEnum = valueList(custom.enum);
    merged.enum = valueList(builtIn.enum).filter((item) => customEnum.includes(item));
  }
  return merged;
}

function validateCustomFieldConstraints(
  builtIn: JsonSchema,
  custom: JsonSchema,
  nodeId: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (builtIn.type && custom.type && builtIn.type !== custom.type) {
    issues.push(issue('invalid_schema', `内置字段类型为 ${builtIn.type}，不能改写为 ${custom.type}`, {
      nodeId,
      path: `${path}.type`,
    }));
  }
  for (const key of ['minimum', 'minLength'] as const) {
    const builtInValue = schemaBound(builtIn, key);
    const customValue = schemaBound(custom, key);
    if (builtInValue !== undefined && customValue !== undefined && customValue < builtInValue) {
      issues.push(issue('invalid_schema', `${key} 不能低于内置约束 ${builtInValue}`, {
        nodeId,
        path: `${path}.${key}`,
      }));
    }
  }
  for (const key of ['maximum', 'maxLength'] as const) {
    const builtInValue = schemaBound(builtIn, key);
    const customValue = schemaBound(custom, key);
    if (builtInValue !== undefined && customValue !== undefined && customValue > builtInValue) {
      issues.push(issue('invalid_schema', `${key} 不能高于内置约束 ${builtInValue}`, {
        nodeId,
        path: `${path}.${key}`,
      }));
    }
  }

  const merged = mergeOutputSchema(builtIn, custom);
  const minimum = schemaBound(merged, 'minimum');
  const maximum = schemaBound(merged, 'maximum');
  const minLength = schemaBound(merged, 'minLength');
  const maxLength = schemaBound(merged, 'maxLength');
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    issues.push(issue('invalid_schema', '自定义数值范围与内置约束没有交集', { nodeId, path }));
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    issues.push(issue('invalid_schema', '自定义长度范围与内置约束没有交集', { nodeId, path }));
  }
  if (Array.isArray(builtIn.enum) && Array.isArray(custom.enum)) {
    if (custom.enum.some((item) => !builtIn.enum!.includes(item))) {
      issues.push(issue('invalid_schema', '自定义 enum 只能缩小内置取值范围', { nodeId, path: `${path}.enum` }));
    }
  }

  for (const [key, builtInProperty] of Object.entries(builtIn.properties ?? {})) {
    const customProperty = custom.properties?.[key];
    if (isRecord(customProperty)) {
      validateCustomFieldConstraints(
        builtInProperty,
        customProperty as JsonSchema,
        nodeId,
        `${path}.properties.${key}`,
        issues,
      );
    }
  }
  if (builtIn.items !== undefined && isRecord(custom.items)) {
    validateCustomFieldConstraints(
      builtIn.items,
      custom.items as JsonSchema,
      nodeId,
      `${path}.items`,
      issues,
    );
  }
}

/** 自定义输出 Schema 可以追加字段和收紧约束，但不能放松内置契约。 */
function validateOutputFieldConstraints(
  node: WorkflowNode,
  definition: WorkflowDefinition,
  issues: ValidationIssue[],
): void {
  if (!isRecord(node.outputSchema) || !isRecord(node.outputSchema.properties)) return;
  const builtInProperties = builtInOutputSchema(node, definition)?.properties ?? {};
  for (const [key, customProperty] of Object.entries(node.outputSchema.properties)) {
    const builtInProperty = builtInProperties[key];
    if (!builtInProperty || !isRecord(customProperty)) continue;
    validateCustomFieldConstraints(
      builtInProperty,
      customProperty as JsonSchema,
      node.id,
      `nodes.${node.id}.outputSchema.properties.${key}`,
      issues,
    );
  }
}

function schemaFields(schema: unknown): Set<string> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return new Set();
  return new Set(Object.keys(schema.properties));
}

function inputFields(definition: WorkflowDefinition): Set<string> {
  return schemaFields(definition.inputSchema);
}

function builtInOutputSchema(node: WorkflowNode, definition: WorkflowDefinition): JsonSchema | undefined {
  if (node.type === 'input') return definition.inputSchema;
  const properties = ownEntry(BUILTIN_OUTPUT_PROPERTIES, node.type);
  return properties ? { type: 'object', properties } : undefined;
}

/**
 * 返回执行器实际使用的完整输出 Schema：内置字段与显式自定义字段递归合并。
 * additionalProperties: false 因此不会误伤 text、traceId 等内置字段。
 */
export function getEffectiveOutputSchema(
  node: WorkflowNode,
  definition: WorkflowDefinition,
): JsonSchema | undefined {
  const builtIn = builtInOutputSchema(node, definition);
  const custom = node.outputSchema;
  if (!builtIn) return custom;
  if (!custom) return builtIn;
  return mergeOutputSchema(builtIn, custom);
}

function outputFields(node: WorkflowNode, definition: WorkflowDefinition): Set<string> {
  return schemaFields(getEffectiveOutputSchema(node, definition));
}

function validateLimits(
  limits: unknown,
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  if (limits === undefined) return;
  if (!isRecord(limits)) {
    issues.push(issue('invalid_limits', 'limits 必须是对象', { path: 'limits' }));
    return;
  }
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.includes(key as keyof WorkflowLimits)) {
      issues.push(issue('invalid_limits', `不支持的限额字段 ${key}`, { path: `limits.${key}` }));
    }
  }
  const caps = ctx.platformLimits ?? PLATFORM_LIMIT_CAPS;
  for (const key of LIMIT_KEYS) {
    if (!hasOwn(limits, key) || limits[key] === undefined) continue;
    const requested = limits[key];
    if (typeof requested !== 'number' || !Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0) {
      issues.push(issue('invalid_limits', `限额 ${key} 必须是正整数`, { path: `limits.${key}` }));
      continue;
    }
    // 平台上限可能只覆盖部分项；缺失项按内置平台上限比较，
    // 不能因为 `caps[key]` 为 undefined 就把超限值放过去。
    const cap = effectiveLimitCap(caps, key);
    if (requested > cap) {
      issues.push(issue('limit_exceeded', `限额 ${key} 超过平台上限 ${cap}`, { path: `limits.${key}` }));
    }
  }
  if (
    typeof limits.timeoutMs === 'number' &&
    Number.isInteger(limits.timeoutMs) &&
    limits.timeoutMs > 0 &&
    typeof limits.approvalTimeoutMs === 'number' &&
    Number.isInteger(limits.approvalTimeoutMs) &&
    limits.approvalTimeoutMs > 0 &&
    limits.approvalTimeoutMs > limits.timeoutMs
  ) {
    issues.push(issue('invalid_limits', '审批等待时限不能超过运行时长上限', { path: 'limits.approvalTimeoutMs' }));
  }
}

function uncheckedResourceCheck(): ResourceCheckSummary {
  return { models: 'skipped', tools: 'skipped', knowledgeScopes: 'skipped' };
}

function categoryStatus(required: boolean, scope: unknown): ResourceCheckStatus {
  if (!required) return 'not_required';
  return Array.isArray(scope) ? 'performed' : 'skipped';
}

/**
 * 按定义实际使用的资源类别报告状态，不能用某一类白名单代替其他类别。
 *
 * 统计基于**原始节点列表**而不是校验通过的节点：节点 ID 非法而被丢弃时，
 * 资源需求不能跟着一起消失，否则会漏报成「不需要该白名单」。
 */
function resourceCheckStatus(rawNodes: unknown[], ctx: ValidationContext): ResourceCheckSummary {
  let needsModels = false;
  let needsTools = false;
  let needsKnowledgeScopes = false;
  for (const rawNode of rawNodes) {
    if (!isRecord(rawNode)) continue;
    const node = rawNode as unknown as WorkflowNode;
    if (typeof node.type !== 'string') continue;
    const config = isRecord(node.config) ? node.config : {};
    if (node.type === 'llm' || node.type === 'agent') needsModels = true;
    if (node.type === 'tool') needsTools = true;
    if (node.type === 'agent' && config.allowedTools !== undefined) {
      // 只要配置了工具键就算「用到了工具」：
      // 形态非法（字符串、数字）时同样要计入，否则工具白名单没校验会被标成 not_required，
      // 而 not_required 的语义是「不使用该资源」，与实际情况相反。
      // 合法数组仍按原有口径：空数组不算用到工具。
      if (!Array.isArray(config.allowedTools) || config.allowedTools.length > 0) {
        needsTools = true;
      }
    }
    if (node.type === 'knowledge' && config.knowledgeScope !== undefined) {
      needsKnowledgeScopes = true;
    }
  }
  return {
    models: categoryStatus(needsModels, ctx.resources?.models),
    tools: categoryStatus(needsTools, ctx.resources?.tools),
    knowledgeScopes: categoryStatus(needsKnowledgeScopes, ctx.resources?.knowledgeScopes),
  };
}

/** 校验来自不可信 JSON 的工作流定义，一次返回全部可定位问题。 */
export function validateDefinition(
  definition: WorkflowDefinition,
  ctx: ValidationContext = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const resourceCheck = uncheckedResourceCheck();
  if (!isRecord(definition)) {
    return {
      ok: false,
      issues: [issue('invalid_definition', '工作流定义必须是对象')],
      resourceCheck,
    };
  }
  const rawDefinition = definition as unknown as Record<string, unknown>;

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(definition.schemaVersion)) {
    issues.push(issue('unsupported_schema_version', `不支持的 schemaVersion：${definition.schemaVersion}`));
  }
  if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
    issues.push(issue('missing_name', '工作流名称不能为空'));
  }
  validateSchema(definition.inputSchema, 'inputSchema', issues);
  if (isRecord(definition.inputSchema) && definition.inputSchema.type !== 'object') {
    issues.push(issue('invalid_schema', '顶层 inputSchema 根类型必须显式声明为 object', {
      path: 'inputSchema.type',
    }));
  }
  validateLimits(rawDefinition.limits, ctx, issues);

  const rawNodes = Array.isArray(rawDefinition.nodes) ? rawDefinition.nodes : [];
  const rawEdges = Array.isArray(rawDefinition.edges) ? rawDefinition.edges : [];
  if (rawDefinition.nodes !== undefined && !Array.isArray(rawDefinition.nodes)) {
    issues.push(issue('invalid_definition', 'nodes 必须是数组', { path: 'nodes' }));
  }
  if (rawDefinition.edges !== undefined && !Array.isArray(rawDefinition.edges)) {
    issues.push(issue('invalid_definition', 'edges 必须是数组', { path: 'edges' }));
  }
  if (rawNodes.length === 0) issues.push(issue('no_nodes', '工作流至少要有一个节点'));
  if (rawNodes.length > STRUCTURE_LIMITS.maxNodes) {
    issues.push(issue('too_many_nodes', `节点数超过上限 ${STRUCTURE_LIMITS.maxNodes}`));
  }
  if (rawEdges.length > STRUCTURE_LIMITS.maxEdges) {
    issues.push(issue('too_many_edges', `边数超过上限 ${STRUCTURE_LIMITS.maxEdges}`));
  }
  // 结构规模已经超限时**立即返回**：超限定义不可能通过发布，继续做祖先集合计算
  // 会把一次校验放大到 O(N×(N+E))，几百毫秒到十几秒不等，
  // 等于给发布 / 启动接口留了一个可被恶意输入放大的 CPU 消耗点。
  if (rawNodes.length > STRUCTURE_LIMITS.maxNodes || rawEdges.length > STRUCTURE_LIMITS.maxEdges) {
    return { ok: false, issues, resourceCheck };
  }

  const nodes: WorkflowNode[] = [];
  const byId = new Map<string, WorkflowNode>();
  for (const rawNode of rawNodes) {
    const id = isRecord(rawNode) ? rawNode.id : undefined;
    if (!isRecord(rawNode) || typeof id !== 'string' || !NODE_ID_PATTERN.test(id)) {
      issues.push(issue('invalid_node_id', `节点 ID 非法：${String(id)}`, { nodeId: typeof id === 'string' ? id : '' }));
      continue;
    }
    if (byId.has(id)) {
      issues.push(issue('duplicate_node_id', `节点 ID 重复：${id}`, { nodeId: id }));
      continue;
    }
    const node = rawNode as unknown as WorkflowNode;
    byId.set(id, node);
    nodes.push(node);
  }

  const supported = ctx.nodeImplementations ?? SUPPORTED_NODE_IMPLEMENTATIONS;
  for (const node of nodes) {
    if (!NODE_TYPES.includes(node.type)) {
      issues.push(issue('unknown_node_type', `不支持的节点类型：${String(node.type)}`, { nodeId: node.id }));
      continue;
    }
    const implVersion = node.implVersion ?? 1;
    // 白名单表来自平台侧入参，同样是不可信输入：
    // 表项不是数组时 .includes() / .join() 会抛异常，把校验器变成异常入口（见设计文档 13）。
    const rawAllowed: unknown = ownEntry(supported as unknown as Record<string, unknown>, node.type);
    if (rawAllowed !== undefined && !Array.isArray(rawAllowed)) {
      issues.push(issue(
        'invalid_node_implementations',
        `节点类型 ${node.type} 的实现版本白名单必须是数组`,
        { nodeId: node.id, path: `nodes.${node.id}.implVersion` },
      ));
    } else {
      const allowed = (rawAllowed ?? []) as readonly number[];
      if (!allowed.includes(implVersion)) {
        issues.push(issue(
          'unsupported_impl_version',
          `节点 ${node.id} 的实现版本 ${implVersion} 不受支持（支持：${allowed.join(', ')}）`,
          { nodeId: node.id, path: `nodes.${node.id}.implVersion` },
        ));
      }
    }
    if (
      node.position !== undefined &&
      (!isRecord(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))
    ) {
      issues.push(issue('invalid_position', '节点坐标必须是有限数值', {
        nodeId: node.id,
        path: `nodes.${node.id}.position`,
      }));
    }
    validateNodeConfig(node, definition, issues);
  }

  // 带分支标记的出边按「源节点」归集：
  // 人工审核节点既可以是「带 approved/rejected」的分支流程，
  // 也可以是「一条出边都不带 branch」的线性流程（见 6.7），后者按普通节点处理。
  const labelledSources = new Set<string>();
  for (const rawEdge of rawEdges) {
    if (!isRecord(rawEdge) || typeof rawEdge.source !== 'string') continue;
    if ((rawEdge as { branch?: unknown }).branch !== undefined) labelledSources.add(rawEdge.source);
  }

  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  const seenEdge = new Set<string>();
  for (const rawEdge of rawEdges) {
    const id = isRecord(rawEdge) ? rawEdge.id : undefined;
    if (!isRecord(rawEdge) || typeof id !== 'string' || id.length === 0) {
      issues.push(issue('invalid_edge_id', '边必须有字符串类型的 id'));
      continue;
    }
    if (edgeIds.has(id)) {
      issues.push(issue('duplicate_edge_id', `边 ID 重复：${id}`, { edgeId: id }));
      continue;
    }
    edgeIds.add(id);
    if (typeof rawEdge.source !== 'string' || typeof rawEdge.target !== 'string') {
      issues.push(issue('invalid_edge', '边的 source 和 target 必须是字符串', { edgeId: id }));
      continue;
    }
    const edge = rawEdge as unknown as WorkflowEdge;
    edges.push(edge);
    const sourceNode = byId.get(edge.source);
    if (!sourceNode) issues.push(issue('dangling_edge', `边的起点不存在：${edge.source}`, { edgeId: id }));
    if (!byId.has(edge.target)) issues.push(issue('dangling_edge', `边的终点不存在：${edge.target}`, { edgeId: id }));
    if (edge.source === edge.target) issues.push(issue('self_loop', `不允许自环：${id}`, { edgeId: id }));

    // 分支取值按「源节点类型」判定：条件节点只允许 true/false，
    // 人工审核节点只允许 approved/rejected，其它节点类型不允许带 branch。
    const allowedBranches = sourceNode ? ownEntry(NODE_BRANCH_VALUES, sourceNode.type) : undefined;
    // 线性审核流程：该审核节点没有任何带分支标记的出边，按普通节点处理，不做分支校验。
    const isLinearApproval = sourceNode?.type === 'approval' && !labelledSources.has(edge.source);
    if (!allowedBranches) {
      if (edge.branch !== undefined) {
        issues.push(issue('invalid_branch', '该节点类型的边不允许携带 branch', { edgeId: id, path: `edges.${id}.branch` }));
      }
    } else if (!isLinearApproval && (edge.branch === undefined || !allowedBranches.includes(edge.branch))) {
      issues.push(issue(
        'invalid_branch',
        `分支取值非法：${String(edge.branch)}（${sourceNode?.type} 节点只允许 ${allowedBranches.join(' / ')}）`,
        { edgeId: id, path: `edges.${id}.branch` },
      ));
    }

    const branch = allowedBranches ? (edge.branch ?? '') : '';
    const key = `${edge.source}->${edge.target}::${branch}`;
    if (seenEdge.has(key)) {
      issues.push(issue('duplicate_edge', `重复的边：${edge.source} → ${edge.target}`, { edgeId: id }));
    }
    seenEdge.add(key);
  }

  const inputNodes = nodes.filter((node) => node.type === 'input');
  const outputNodes = nodes.filter((node) => node.type === 'output');
  if (inputNodes.length !== 1) {
    issues.push(issue('invalid_input_node_count', `输入节点必须恰好一个，实际 ${inputNodes.length}`));
  }
  if (outputNodes.length !== 1) {
    issues.push(issue('invalid_output_node_count', `输出节点必须恰好一个，实际 ${outputNodes.length}`));
  }
  if (topologicalOrder(nodes, edges) === null) issues.push(issue('cycle_detected', '工作流存在循环'));

  if (inputNodes.length === 1 && outputNodes.length === 1) {
    const fromInput = reachableFrom([inputNodes[0].id], edges);
    const toOutput = canReach([outputNodes[0].id], edges);
    for (const node of nodes) {
      if (!fromInput.has(node.id)) {
        issues.push(issue('unreachable_node', `节点无法从输入节点到达：${node.id}`, { nodeId: node.id }));
      }
      if (!toOutput.has(node.id)) {
        issues.push(issue('dead_end_node', `节点无法到达输出节点：${node.id}`, { nodeId: node.id }));
      }
    }
  }

  for (const node of nodes) {
    if (node.type !== 'condition') continue;
    const branches = new Set(edges.filter((edge) => edge.source === node.id).map((edge) => edge.branch));
    if (!branches.has('true') || !branches.has('false')) {
      issues.push(issue('missing_branch', `条件节点必须同时有 true 与 false 出口：${node.id}`, { nodeId: node.id }));
    }
  }

  for (const node of nodes) {
    const ancestors = ancestorsOf({ ...definition, nodes, edges }, node.id);
    // 引用收集的深度基准必须与配置深度校验一致：
    // 配置的**字段值**是深度 0（validateConfigValue 的口径），
    // 若这里对整个 config 收集，边界层上的引用会因为深一层而被截断，
    // 悬空引用 / 下游引用 / 未声明字段引用会整体逃过校验。
    const refs = new Set<string>();
    const config = isRecord(node.config) ? node.config : {};
    for (const [key, value] of Object.entries(config)) {
      // 条件 AST 有自己的逻辑深度上限与独立收集器，不走通用遍历。
      if (node.type === 'condition' && key === 'condition') continue;
      for (const ref of collectRefs(value as TemplatedValue)) refs.add(ref);
    }
    if (node.type === 'condition') {
      for (const ref of collectConditionRefs(config.condition)) refs.add(ref);
    }
    for (const ref of refs) {
      const target = parseRef(ref);
      const path = `nodes.${node.id}.config`;
      if (!target) {
        issues.push(issue('invalid_ref', `引用格式非法：${ref}`, { nodeId: node.id, path }));
        continue;
      }
      if (target.kind === 'input') {
        if (!inputFields(definition).has(target.field)) {
          issues.push(issue('unknown_ref_field', `引用指向未声明的输入字段：${ref}`, { nodeId: node.id, path }));
        }
        continue;
      }
      const source = byId.get(target.nodeId);
      if (!source) {
        issues.push(issue('unknown_ref_node', `引用指向不存在的节点：${ref}`, { nodeId: node.id, path }));
        continue;
      }
      if (!ancestors.has(target.nodeId)) {
        issues.push(issue('non_upstream_ref', `引用必须指向上游节点：${ref}`, { nodeId: node.id, path }));
        continue;
      }
      if (!outputFields(source, definition).has(target.field)) {
        issues.push(issue('unknown_ref_field', `引用指向未声明的节点输出字段：${ref}`, { nodeId: node.id, path }));
      }
    }
  }

  const resources = ctx.resources;
  if (resources) {
    for (const node of nodes) {
      const config = isRecord(node.config) ? node.config : {};
      if (node.type === 'llm' || node.type === 'agent') {
        const model = config.model;
        if (typeof model === 'string' && resources.models && !resources.models.includes(model)) {
          issues.push(issue('model_not_allowed', `模型不在当前可用范围：${model}`, {
            nodeId: node.id,
            path: `nodes.${node.id}.config.model`,
          }));
        }
      }
      if (node.type === 'tool') {
        const serverId = config.serverId;
        const tool = config.tool;
        if (typeof serverId === 'string' && typeof tool === 'string' && resources.tools) {
          if (!resources.tools.includes(`${serverId}/${tool}`)) {
            issues.push(issue('tool_not_allowed', `工具不在当前可用范围：${serverId}/${tool}`, {
              nodeId: node.id,
              path: `nodes.${node.id}.config.tool`,
            }));
          }
        }
      }
      if (node.type === 'knowledge') {
        const scope = config.knowledgeScope;
        if (typeof scope === 'string' && resources.knowledgeScopes && !resources.knowledgeScopes.includes(scope)) {
          issues.push(issue('knowledge_scope_not_allowed', `知识范围不在当前可用范围：${scope}`, {
            nodeId: node.id,
            path: `nodes.${node.id}.config.knowledgeScope`,
          }));
        }
      }
      if (node.type === 'agent' && Array.isArray(config.allowedTools) && resources.tools) {
        for (const tool of config.allowedTools) {
          if (typeof tool === 'string' && !resources.tools.includes(tool)) {
            issues.push(issue('tool_not_allowed', `Agent 工具不在当前可用范围：${tool}`, {
              nodeId: node.id,
              path: `nodes.${node.id}.config.allowedTools`,
            }));
          }
        }
      }
    }
  }

  return { ok: issues.length === 0, issues, resourceCheck: resourceCheckStatus(rawNodes, ctx) };
}
