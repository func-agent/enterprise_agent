/**
 * CEL 风格策略表达式求值器（对应 4.3「Cedar/CEL 策略 —— 租户级 allow/deny 模型与工具」）。
 *
 * 支持：
 *   字面量        123  "abc"  true  false  null
 *   路径访问      principal.tenantId  request.model[0]
 *   逻辑运算      &&  ||  !  （三元 ?:）
 *   比较运算      ==  !=  <  <=  >  >=
 *   算术运算      +  -  *  /  %
 *   成员判断      x in list
 *   内置函数      startsWith / endsWith / contains / matches / size / lower / upper
 *   存在判断      has(principal.role)
 *
 * 故意实现为子集而非完整 CEL —— 覆盖企业策略所需语义即可，便于审计与排错。
 */

export type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | Value[]
  | { [key: string]: Value };

export interface PolicyContext {
  principal: Record<string, Value>;
  request: Record<string, Value>;
  resource?: Record<string, Value>;
}

type TokenType =
  | 'num'
  | 'str'
  | 'ident'
  | 'op'
  | 'punct'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '+', '-', '*', '/', '%'];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // 字符串
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') {
          out += src[j + 1] ?? '';
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ type: 'str', value: out, pos: i });
      i = j + 1;
      continue;
    }
    // 数字
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      tokens.push({ type: 'num', value: src.slice(i, j).replace(/_/g, ''), pos: i });
      i = j;
      continue;
    }
    // 标识符 / 关键字
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // 操作符
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i });
      i += op.length;
      continue;
    }
    // 标点
    if ('().,:?[]'.includes(c)) {
      tokens.push({ type: 'punct', value: c, pos: i });
      i++;
      continue;
    }
    throw new Error(`CEL 表达式非法字符 '${c}' (位置 ${i})`);
  }
  tokens.push({ type: 'eof', value: '', pos: src.length });
  return tokens;
}

type Expr =
  | { kind: 'literal'; value: Value }
  | { kind: 'array'; items: Expr[] }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; target: Expr; property: Expr }
  | { kind: 'index'; target: Expr; index: Expr }
  | { kind: 'call'; callee: Expr; args: Expr[] }
  | { kind: 'unary'; op: string; operand: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'ternary'; cond: Expr; yes: Expr; no: Expr };

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.value !== value) {
      throw new Error(`CEL 解析错误：期望 '${value}'，实际 '${t.value}' (位置 ${t.pos})`);
    }
    return t;
  }

  private match(...values: string[]): boolean {
    if (values.includes(this.peek().value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): Expr {
    const e = this.parseTernary();
    if (this.peek().type !== 'eof') {
      throw new Error(`CEL 解析错误：存在多余 token '${this.peek().value}'`);
    }
    return e;
  }

  private parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.match('?')) {
      const yes = this.parseTernary();
      this.expect(':');
      const no = this.parseTernary();
      return { kind: 'ternary', cond, yes, no };
    }
    return cond;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.match('||')) {
      left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.match('&&')) {
      left = { kind: 'binary', op: '&&', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.match('!')) {
      return { kind: 'unary', op: '!', operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
        this.next();
        left = { kind: 'binary', op: t.value, left, right: this.parseAdditive() };
        continue;
      }
      // `in` 关键字
      if (t.type === 'ident' && t.value === 'in') {
        this.next();
        left = { kind: 'binary', op: 'in', left, right: this.parseAdditive() };
        continue;
      }
      return left;
    }
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        left = { kind: 'binary', op: t.value, left, right: this.parseMultiplicative() };
        continue;
      }
      return left;
    }
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        left = { kind: 'binary', op: t.value, left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): Expr {
    if (this.match('-')) {
      return { kind: 'unary', op: '-', operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.match('.')) {
        const name = this.next();
        if (name.type !== 'ident') throw new Error(`CEL 解析错误：属性名非法 (位置 ${name.pos})`);
        e = { kind: 'member', target: e, property: { kind: 'literal', value: name.value } };
        continue;
      }
      if (this.match('[')) {
        const idx = this.parseTernary();
        this.expect(']');
        e = { kind: 'index', target: e, index: idx };
        continue;
      }
      if (this.match('(')) {
        const args: Expr[] = [];
        if (!this.match(')')) {
          do {
            args.push(this.parseTernary());
          } while (this.match(','));
          this.expect(')');
        }
        e = { kind: 'call', callee: e, args };
        continue;
      }
      return e;
    }
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (t.type === 'num') return { kind: 'literal', value: Number(t.value) };
    if (t.type === 'str') return { kind: 'literal', value: t.value };
    if (t.type === 'ident') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'ident', name: t.value };
    }
    if (t.type === 'punct' && t.value === '(') {
      const e = this.parseTernary();
      this.expect(')');
      return e;
    }
    if (t.type === 'punct' && t.value === '[') {
      const items: Expr[] = [];
      if (!this.match(']')) {
        do {
          items.push(this.parseTernary());
        } while (this.match(','));
        this.expect(']');
      }
      return { kind: 'array', items };
    }
    throw new Error(`CEL 解析错误：意外 token '${t.value}' (位置 ${t.pos})`);
  }
}

const BUILTINS: Record<string, (args: Value[]) => Value> = {
  startsWith: (a) => String(a[0] ?? '').startsWith(String(a[1] ?? '')),
  endsWith: (a) => String(a[0] ?? '').endsWith(String(a[1] ?? '')),
  contains: (a) => {
    if (Array.isArray(a[0])) return a[0].some((x) => deepEqual(x, a[1]));
    return String(a[0] ?? '').includes(String(a[1] ?? ''));
  },
  matches: (a) => new RegExp(String(a[1] ?? '')).test(String(a[0] ?? '')),
  size: (a) => {
    const v = a[0];
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'string') return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    return 0;
  },
  lower: (a) => String(a[0] ?? '').toLowerCase(),
  upper: (a) => String(a[0] ?? '').toUpperCase(),
  int: (a) => Math.trunc(Number(a[0] ?? 0)),
  double: (a) => Number(a[0] ?? 0),
  string: (a) => String(a[0] ?? ''),
};

function deepEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

function resolvePath(root: Record<string, Value>, path: string): Value {
  const parts = path.split('.');
  let cur: any = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur as Value;
}

export function evaluate(expr: Expr, ctx: PolicyContext): Value {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'array':
      return expr.items.map((i) => evaluate(i, ctx));
    case 'ident':
      return resolvePath(ctx as any, expr.name);
    case 'member': {
      const target = evaluate(expr.target, ctx);
      const prop = evaluate(expr.property, ctx);
      if (target === null || target === undefined) return undefined;
      if (Array.isArray(target)) return target[Number(prop)];
      if (typeof target === 'object') return (target as any)[String(prop)];
      return undefined;
    }
    case 'index': {
      const target = evaluate(expr.target, ctx);
      const idx = evaluate(expr.index, ctx);
      if (target === null || target === undefined) return undefined;
      if (Array.isArray(target)) return target[Number(idx)];
      return undefined;
    }
    case 'call': {
      // 支持具名调用 fn(a) 与方法调用 x.fn(a)（方法调用时接收者作为第一个参数）
      let fnName: string | undefined;
      let receiver: Expr | undefined;
      if (expr.callee.kind === 'ident') {
        fnName = expr.callee.name;
      } else if (expr.callee.kind === 'member' && expr.callee.property.kind === 'literal') {
        fnName = String(expr.callee.property.value);
        receiver = expr.callee.target;
      }
      if (!fnName) {
        throw new Error('CEL 表达式错误：仅支持具名函数调用');
      }
      const fn = BUILTINS[fnName];
      const args = expr.args.map((a) => evaluate(a, ctx));
      if (receiver) args.unshift(evaluate(receiver, ctx));
      if (fnName === 'has') {
        // has(principal.role) —— 路径存在性
        if (expr.args[0]?.kind === 'ident') {
          return resolvePath(ctx as any, expr.args[0].name) !== undefined;
        }
        if (expr.args[0]?.kind === 'member' && expr.args[0].property.kind === 'literal') {
          const target = evaluate(expr.args[0].target, ctx);
          if (target && typeof target === 'object') {
            return (target as any)[String(expr.args[0].property.value)] !== undefined;
          }
        }
        return false;
      }
      if (!fn) throw new Error(`CEL 表达式错误：未知函数 '${fnName}'`);
      return fn(args);
    }
    case 'unary': {
      const v = evaluate(expr.operand, ctx);
      if (expr.op === '!') return !truthy(v);
      if (expr.op === '-') return -Number(v ?? 0);
      return v;
    }
    case 'binary': {
      const { op } = expr;
      if (op === '&&') {
        const l = evaluate(expr.left, ctx);
        if (!truthy(l)) return false;
        return truthy(evaluate(expr.right, ctx));
      }
      if (op === '||') {
        const l = evaluate(expr.left, ctx);
        if (truthy(l)) return true;
        return truthy(evaluate(expr.right, ctx));
      }
      const l = evaluate(expr.left, ctx);
      const r = evaluate(expr.right, ctx);
      switch (op) {
        case '==':
          return deepEqual(l, r);
        case '!=':
          return !deepEqual(l, r);
        case '<':
          return Number(l) < Number(r);
        case '<=':
          return Number(l) <= Number(r);
        case '>':
          return Number(l) > Number(r);
        case '>=':
          return Number(l) >= Number(r);
        case '+':
          if (typeof l === 'string' || typeof r === 'string') return `${l}${r}`;
          return Number(l ?? 0) + Number(r ?? 0);
        case '-':
          return Number(l ?? 0) - Number(r ?? 0);
        case '*':
          return Number(l ?? 0) * Number(r ?? 0);
        case '/':
          return Number(r ?? 0) === 0 ? null : Number(l ?? 0) / Number(r ?? 0);
        case '%':
          return Number(r ?? 0) === 0 ? null : Number(l ?? 0) % Number(r ?? 0);
        case 'in': {
          if (Array.isArray(r)) return r.some((x) => deepEqual(x, l));
          if (typeof r === 'string') return String(r).includes(String(l));
          if (r && typeof r === 'object') return Object.prototype.hasOwnProperty.call(r, String(l));
          return false;
        }
        default:
          throw new Error(`CEL 表达式错误：未知运算符 '${op}'`);
      }
    }
    case 'ternary':
      return truthy(evaluate(expr.cond, ctx)) ? evaluate(expr.yes, ctx) : evaluate(expr.no, ctx);
  }
}

function truthy(v: Value): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** 解析并缓存表达式 */
export class CelEngine {
  private cache = new Map<string, Expr>();

  compile(src: string): Expr {
    const cached = this.cache.get(src);
    if (cached) return cached;
    const expr = new Parser(tokenize(src)).parse();
    this.cache.set(src, expr);
    return expr;
  }

  eval(src: string, ctx: PolicyContext): Value {
    return evaluate(this.compile(src), ctx);
  }

  evalBool(src: string, ctx: PolicyContext): boolean {
    return truthy(this.eval(src, ctx));
  }
}
