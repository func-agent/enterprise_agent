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
import { STRUCTURE_LIMITS } from './limits.js';

/**
 * 会造成原型污染的键名。
 *
 * 这类键出现在 Schema 的 `properties` 里时，校验器遍历属性会把注入值写进原型链，
 * 下游读到的属性可能不是定义里声明的那个。
 */
export const FORBIDDEN_PROPERTY_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Schema 校验结果。 */
export interface SchemaCheckResult {
  ok: boolean;
  errors: string[];
}

/**
 * Schema 形态（结构）判定的**公共口径**。
 *
 * 发布期的 checkSchemaSchema 与数据期的 validateValue 必须对同一形态给出同一结论：
 * 一边放过、一边报错甚至直接崩，会让「以为生效其实没校验」。
 * 形态不合法的 Schema 一律在这里给出明确错误，由调用方决定报不报给用户。
 */
function shapeErrors(schema: unknown, path: string): string[] {
  if (!isRecord(schema)) {
    return [`${path}: Schema 必须是对象`];
  }
  const errors: string[] = [];
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    errors.push(`${path}.enum: 必须是非空数组`);
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string'))
  ) {
    errors.push(`${path}.required: 必须是字符串数组`);
  }
  if (
    schema.properties !== undefined &&
    (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))
  ) {
    errors.push(`${path}.properties: 必须是对象`);
  }
  if (schema.items !== undefined && !isRecord(schema.items)) {
    errors.push(`${path}.items: Schema 必须是对象`);
  }
  return errors;
}

/**
 * 检查 Schema 自身是否合法（只允许受支持的子集）。
 *
 * 与「用 Schema 校验数据」是两件事：前者检查定义是否可被平台执行，
 * 后者检查数据是否满足定义。
 */
export function checkSchemaSchema(schema: unknown, path = '$', depth = 0): SchemaCheckResult {
  const errors: string[] = [];
  if (depth > STRUCTURE_LIMITS.maxSchemaDepth) {
    errors.push(`${path}: Schema 嵌套过深`);
    return { ok: false, errors };
  }
  if (schema === undefined) return { ok: true, errors };
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
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

  // 形态判定与 validateValue 共用同一口径（见 shapeErrors）：
  // 两边各写一份必然漂移，出现「一边放过、一边报错」。
  errors.push(...shapeErrors(record, path));

  if (isRecord(record.properties)) {
    for (const [key, sub] of Object.entries(record.properties)) {
      if (FORBIDDEN_PROPERTY_KEYS.includes(key)) {
        errors.push(`${path}.properties.${key}: 不允许使用会造成原型污染的属性名`);
        continue;
      }
      errors.push(...checkSchemaSchema(sub, `${path}.properties.${key}`, depth + 1).errors);
    }
  }

  // required 的语义约束（字段必须已声明）只在形态合法时继续判定：
  // 形态非法的 required 已经在 shapeErrors 里报过，不再叠加语义错误。
  if (Array.isArray(record.required) && record.required.every((item) => typeof item === 'string')) {
    if (record.required.length > 0 && !isRecord(record.properties)) {
      errors.push(`${path}.required: 非空 required 必须配合 properties 声明`);
    } else if (isRecord(record.properties)) {
      const properties = record.properties as Record<string, unknown>;
      for (const field of record.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(properties, field)) {
          errors.push(`${path}.required: 字段 "${field}" 未在 properties 中声明`);
        }
      }
    }
  }

  if (isRecord(record.items)) {
    errors.push(...checkSchemaSchema(record.items, `${path}.items`, depth + 1).errors);
  }
  if (record.additionalProperties !== undefined && record.additionalProperties !== false) {
    errors.push(`${path}.additionalProperties: 只支持 false`);
  }

  for (const key of ['minLength', 'maxLength'] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
      errors.push(`${path}.${key}: 必须是非负整数`);
    }
  }
  for (const key of ['minimum', 'maximum'] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${path}.${key}: 必须是有限数值`);
    }
  }
  if (
    typeof record.minLength === 'number' &&
    typeof record.maxLength === 'number' &&
    record.minLength > record.maxLength
  ) {
    errors.push(`${path}: minLength 不能大于 maxLength`);
  }
  if (
    typeof record.minimum === 'number' &&
    typeof record.maximum === 'number' &&
    record.minimum > record.maximum
  ) {
    errors.push(`${path}: minimum 不能大于 maximum`);
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

  // Schema 本身也是不可信输入（用户提交的 DAG JSON）：
  // 形态非法时必须**报出来**而不是在 .some() / for..of 上抛异常。
  // validateValue 经 index.ts 对外公开，直接调用时崩掉就是纵深防御缺口。
  errors.push(...shapeErrors(schema, path));

  if (typeof value === 'number' && !Number.isFinite(value)) {
    errors.push(`${path}: 数值必须是有限数值`);
    return errors;
  }

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

  // enum 形态非法时不再做命中判定：形态错误已经报过，
  // 再按错误语义去比对只会给出误导性的「取值不在枚举范围内」。
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0) {
    const hit = enumValues.some((item) => item === value);
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
    const properties: Record<string, JsonSchema> = isRecord(schema.properties) ? schema.properties : {};
    // required 形态非法时按「无必填字段」处理：真实语义已由 shapeErrors 报出。
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    for (const key of required) {
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
