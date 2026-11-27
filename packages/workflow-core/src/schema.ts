/**
 * JSON Schema 最小子集校验器 —— 见设计文档 R8。
 *
 * 只支持 type / properties / required / enum / minLength / maxLength /
 * minimum / maximum / items / additionalProperties。
 *
 * **不支持** `$ref` / `allOf` / `anyOf` / `oneOf` / `not` / `pattern` /
 * `patternProperties` / `format` / `if-then-else`：
 * - `pattern` 会带来 ReDoS 风险，业务用户提交的正则一律拒绝；
 * - 其余组合关键字会显著扩大实现面，V1 不需要。
 *
 * 遇到未支持的关键字时**报错**（而不是忽略），避免「以为生效其实没校验」。
 */
import type { JsonSchema, JsonSchemaType } from './types.js';

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'items',
  'additionalProperties',
]);

const SUPPORTED_TYPES: readonly JsonSchemaType[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
];

/** Schema 校验结果。 */
export interface SchemaCheckResult {
  ok: boolean;
  errors: string[];
}

/**
 * 检查 Schema 自身是否合法（只允许受支持的子集）。
 *
 * 与「用 Schema 校验数据」是两件事：前者检查定义是否可被平台执行，
 * 后者检查数据是否满足定义。
 */
export function checkSchemaSchema(schema: unknown, path = '$', depth = 0): SchemaCheckResult {
  const errors: string[] = [];
  if (depth > 16) {
    errors.push(`${path}: Schema 嵌套过深`);
    return { ok: false, errors };
  }
  if (schema === undefined || schema === null) return { ok: true, errors };
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, errors: [`${path}: Schema 必须是对象`] };
  }
  const record = schema as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      errors.push(`${path}: 不支持的 Schema 关键字 "${key}"`);
    }
  }

  if (record.type !== undefined) {
    if (typeof record.type !== 'string' || !SUPPORTED_TYPES.includes(record.type as JsonSchemaType)) {
      errors.push(`${path}.type: 不支持的类型 "${String(record.type)}"`);
    }
  }

  if (record.enum !== undefined) {
    if (!Array.isArray(record.enum) || record.enum.length === 0) {
      errors.push(`${path}.enum: 必须是非空数组`);
    }
  }

  if (record.properties !== undefined) {
    if (!record.properties || typeof record.properties !== 'object' || Array.isArray(record.properties)) {
      errors.push(`${path}.properties: 必须是对象`);
    } else {
      for (const [key, sub] of Object.entries(record.properties as Record<string, unknown>)) {
        errors.push(...checkSchemaSchema(sub, `${path}.properties.${key}`, depth + 1).errors);
      }
    }
  }

  if (record.required !== undefined) {
    if (!Array.isArray(record.required) || record.required.some((item) => typeof item !== 'string')) {
      errors.push(`${path}.required: 必须是字符串数组`);
    }
  }

  if (record.items !== undefined) {
    errors.push(...checkSchemaSchema(record.items, `${path}.items`, depth + 1).errors);
  }

  if (record.additionalProperties !== undefined && typeof record.additionalProperties !== 'boolean') {
    errors.push(`${path}.additionalProperties: 只支持布尔值`);
  }

  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum'] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${path}.${key}: 必须是有限数值`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function typeOf(value: unknown): JsonSchemaType {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null' as unknown as JsonSchemaType;
  return typeof value as JsonSchemaType;
}

/**
 * 用 Schema 校验数据。
 *
 * 校验失败时返回字段路径列表，便于定位到画布上的具体输入。
 */
export function validateValue(value: unknown, schema: JsonSchema | undefined, path = '$'): string[] {
  if (!schema) return [];
  const errors: string[] = [];

  if (schema.type) {
    const actual = typeOf(value);
    const matched =
      schema.type === 'number'
        ? actual === 'number' || actual === 'integer'
        : schema.type === actual;
    if (!matched) {
      errors.push(`${path}: 类型应为 ${schema.type}，实际为 ${actual}`);
      return errors;
    }
  }

  if (schema.enum && schema.enum.length > 0) {
    const hit = schema.enum.some((item) => item === value);
    if (!hit) errors.push(`${path}: 取值不在允许的枚举范围内`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: 长度不能小于 ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: 长度不能大于 ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: 不能小于 ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: 不能大于 ${schema.maximum}`);
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        errors.push(`${path}.${key}: 缺少必填字段`);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        errors.push(...validateValue(record[key], sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${path}.${key}: 不允许的未声明字段`);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateValue(item, schema.items, `${path}[${index}]`));
    });
  }

  return errors;
}
