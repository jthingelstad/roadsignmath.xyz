// The equation checker: parses a way's text, says whether it is true, and lists the numbers it
// uses. The app has its own copy of these rules in Swift; both are tested against
// contracts/equation-vectors.json, so change the vectors with the code.
//
// Grammar (lowest binding first):
//   equation := expr ('=' expr)+
//   expr     := term (('+' | '−') term)*
//   term     := unary (('×' | '÷') unary)*
//   unary    := '−' unary | power
//   power    := root ('^' unary)?          right-associative
//   root     := '√' root | postfix         √ applies to what follows: √4! is √(4!)
//   postfix  := primary '!'*
//   primary  := number | '(' expr ')'
// ASCII stand-ins are accepted (- * x / sqrt) and come back in canonical form.

export type Node =
  | { op: 'num'; text: string }
  | { op: 'add' | 'sub' | 'mul' | 'div' | 'pow'; left: Node; right: Node }
  | { op: 'neg' | 'sqrt' | 'fact' | 'group'; arg: Node };

export type CheckError = 'empty' | 'parse' | 'no-equals' | 'divide-by-zero' | 'not-real' | 'too-big' | 'not-true';

export type Check =
  | { ok: true; canonical: string; sides: Node[]; value: string; numbers: string[] }
  | { ok: false; error: CheckError; message: string; canonical?: string; numbers?: string[]; values?: string[] };

const MAX_LENGTH = 400;
const MAX_BITS = 4096n;

// ---------------------------------------------------------------------------------------------
// Tokens

type Token = { kind: 'num'; text: string } | { kind: 'op'; text: string };

const OPERATORS: Record<string, string> = {
  '+': '+',
  '-': '−',
  '−': '−',
  '–': '−',
  '*': '×',
  '×': '×',
  '·': '×',
  x: '×',
  '/': '÷',
  '÷': '÷',
  '^': '^',
  '√': '√',
  '!': '!',
  '(': '(',
  ')': ')',
  '=': '='
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(input.slice(i));
      if (!m) throw new ParseError(`“${c}” is not a number`);
      tokens.push({ kind: 'num', text: normalizeNumber(m[0]) });
      i += m[0].length;
      continue;
    }
    if (input.startsWith('sqrt', i)) {
      tokens.push({ kind: 'op', text: '√' });
      i += 4;
      continue;
    }
    const op = OPERATORS[c];
    if (!op) throw new ParseError(`“${c}” isn’t something the checker knows`);
    tokens.push({ kind: 'op', text: op });
    i++;
  }
  return tokens;
}

/** "07" → "7", ".5" → "0.5", "2.50" → "2.5". Exported so sign numbers compare the same way. */
export function normalizeNumber(text: string): string {
  let [whole, frac = ''] = text.trim().split('.');
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  frac = frac.replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

class ParseError extends Error {}

// ---------------------------------------------------------------------------------------------
// Parser

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  equation(): Node[] {
    const sides = [this.expr()];
    while (this.peekOp('=')) {
      this.i++;
      sides.push(this.expr());
    }
    if (this.i < this.tokens.length) throw new ParseError(`Unexpected “${this.tokens[this.i].text}”`);
    return sides;
  }

  private expr(): Node {
    let left = this.term();
    while (this.peekOp('+') || this.peekOp('−')) {
      const op = this.tokens[this.i++].text === '+' ? 'add' : 'sub';
      left = { op, left, right: this.term() };
    }
    return left;
  }

  private term(): Node {
    let left = this.unary();
    while (this.peekOp('×') || this.peekOp('÷')) {
      const op = this.tokens[this.i++].text === '×' ? 'mul' : 'div';
      left = { op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    if (this.peekOp('−')) {
      this.i++;
      return { op: 'neg', arg: this.unary() };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.root();
    if (this.peekOp('^')) {
      this.i++;
      return { op: 'pow', left: base, right: this.unary() };
    }
    return base;
  }

  private root(): Node {
    if (this.peekOp('√')) {
      this.i++;
      return { op: 'sqrt', arg: this.root() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.peekOp('!')) {
      this.i++;
      node = { op: 'fact', arg: node };
    }
    return node;
  }

  private primary(): Node {
    const t = this.tokens[this.i];
    if (!t) throw new ParseError('The math ends too soon');
    if (t.kind === 'num') {
      this.i++;
      if (this.tokens[this.i]?.kind === 'num' || this.peekOp('(') || this.peekOp('√')) {
        throw new ParseError(`Put an operator after ${t.text}`);
      }
      return { op: 'num', text: t.text };
    }
    if (t.text === '(') {
      this.i++;
      const inner = this.expr();
      if (!this.peekOp(')')) throw new ParseError('A bracket is never closed');
      this.i++;
      return { op: 'group', arg: inner };
    }
    throw new ParseError(`Unexpected “${t.text}”`);
  }

  private peekOp(text: string): boolean {
    const t = this.tokens[this.i];
    return t?.kind === 'op' && t.text === text;
  }
}

// ---------------------------------------------------------------------------------------------
// Values: exact rationals where possible, a float where a root is irrational.

type Value = { exact: true; n: bigint; d: bigint } | { exact: false; v: number };

class MathError extends Error {
  constructor(
    readonly code: CheckError,
    message: string
  ) {
    super(message);
  }
}

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};

function rational(n: bigint, d: bigint): Value {
  if (d === 0n) throw new MathError('divide-by-zero', 'Something is divided by zero');
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  n /= g;
  d /= g;
  if (bits(n) > MAX_BITS || bits(d) > MAX_BITS) throw new MathError('too-big', 'The numbers get too big to check');
  return { exact: true, n, d };
}

const bits = (x: bigint): bigint => BigInt((x < 0n ? -x : x).toString(2).length);
/** The nearest float. Huge rationals are scaled first so n/d doesn't become ∞/∞; one beyond the float range is ±∞. */
function toFloat(v: Value): number {
  if (!v.exact) return v.v;
  let { n, d } = v;
  const shift = (bits(n) > bits(d) ? bits(d) : bits(n)) - 1000n;
  if (shift > 0n) {
    n >>= shift;
    d >>= shift;
  }
  return Number(n) / Number(d);
}

function float(v: number): Value {
  if (!Number.isFinite(v)) throw new MathError('too-big', 'The numbers get too big to check');
  return { exact: false, v };
}

function parseNumber(text: string): Value {
  const [whole, frac = ''] = text.split('.');
  return rational(BigInt(whole + frac), 10n ** BigInt(frac.length));
}

/** Floor of √n by Newton's method, starting above the root so it only falls: O(log bits) steps. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << ((bits(n) + 1n) / 2n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function evaluate(node: Node): Value {
  switch (node.op) {
    case 'num':
      return parseNumber(node.text);
    case 'group':
      return evaluate(node.arg);
    case 'neg': {
      const a = evaluate(node.arg);
      return a.exact ? rational(-a.n, a.d) : float(-a.v);
    }
    case 'add':
    case 'sub':
    case 'mul':
    case 'div': {
      const a = evaluate(node.left);
      const b = evaluate(node.right);
      if (a.exact && b.exact) {
        if (node.op === 'add') return rational(a.n * b.d + b.n * a.d, a.d * b.d);
        if (node.op === 'sub') return rational(a.n * b.d - b.n * a.d, a.d * b.d);
        if (node.op === 'mul') return rational(a.n * b.n, a.d * b.d);
        return rational(a.n * b.d, a.d * b.n);
      }
      const x = toFloat(a);
      const y = toFloat(b);
      if (node.op === 'div' && Math.abs(y) < 1e-12)
        throw new MathError('divide-by-zero', 'Something is divided by zero');
      return float(node.op === 'add' ? x + y : node.op === 'sub' ? x - y : node.op === 'mul' ? x * y : x / y);
    }
    case 'sqrt': {
      const a = evaluate(node.arg);
      if (a.exact ? a.n < 0n : a.v < 0) throw new MathError('not-real', 'There is no square root of a negative number');
      if (a.exact) {
        const rn = isqrt(a.n);
        const rd = isqrt(a.d);
        if (rn * rn === a.n && rd * rd === a.d) return rational(rn, rd);
      }
      return float(Math.sqrt(toFloat(a)));
    }
    case 'fact': {
      const a = evaluate(node.arg);
      if (!a.exact || a.d !== 1n || a.n < 0n) {
        throw new MathError('not-real', 'Factorials only work on whole numbers 0 and up');
      }
      if (a.n > 200n) throw new MathError('too-big', 'The numbers get too big to check');
      let r = 1n;
      for (let k = 2n; k <= a.n; k++) r *= k;
      return rational(r, 1n);
    }
    case 'pow': {
      const a = evaluate(node.left);
      const b = evaluate(node.right);
      if (a.exact && b.exact && b.d === 1n) {
        const e = b.n < 0n ? -b.n : b.n;
        if (e * bits(a.n > a.d ? a.n : a.d) > MAX_BITS)
          throw new MathError('too-big', 'The numbers get too big to check');
        if (a.n === 0n && b.n < 0n) throw new MathError('divide-by-zero', 'Something is divided by zero');
        return b.n < 0n ? rational(a.d ** e, a.n ** e) : rational(a.n ** e, a.d ** e);
      }
      const r = Math.pow(toFloat(a), toFloat(b));
      if (Number.isNaN(r)) throw new MathError('not-real', 'That power has no real answer');
      return float(r);
    }
  }
}

function equal(a: Value, b: Value): boolean {
  if (a.exact && b.exact) return a.n === b.n && a.d === b.d;
  const x = toFloat(a);
  const y = toFloat(b);
  // An exact side beyond the float range can't equal an approximate one, which is always finite.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
}

/** How a side's value reads to a person: "2", "-3", "0.75", "1/3", "≈1.4142". */
export function valueText(v: Value): string {
  if (!v.exact) return `≈${Number(v.v.toPrecision(6))}`;
  if (v.d === 1n) return v.n.toString();
  let d = v.d;
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  if (d === 1n) return String(Number(v.n) / Number(v.d));
  return `${v.n}/${v.d}`;
}

// ---------------------------------------------------------------------------------------------
// Text

const BINARY: Record<string, string> = { add: '+', sub: '−', mul: '×', div: '÷', pow: '^' };

/** Canonical text: Unicode operators, spaces around + − × ÷ =, none around ^ √ !. */
export function format(node: Node): string {
  switch (node.op) {
    case 'num':
      return node.text;
    case 'group':
      return `(${format(node.arg)})`;
    case 'neg':
      return `−${format(node.arg)}`;
    case 'sqrt':
      return `√${format(node.arg)}`;
    case 'fact':
      return `${format(node.arg)}!`;
    case 'pow':
      return `${format(node.left)}^${format(node.right)}`;
    default:
      return `${format(node.left)} ${BINARY[node.op]} ${format(node.right)}`;
  }
}

/** Every number literal, in reading order. The 2 of a square root is not one. */
export function numbersIn(node: Node, out: string[] = []): string[] {
  if (node.op === 'num') out.push(node.text);
  else if ('arg' in node) numbersIn(node.arg, out);
  else {
    numbersIn(node.left, out);
    numbersIn(node.right, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The check

export function check(text: string): Check {
  if (!text.trim()) return { ok: false, error: 'empty', message: 'Write some math first' };
  if (text.length > MAX_LENGTH) return { ok: false, error: 'too-big', message: 'That math is too long to check' };
  let sides: Node[];
  try {
    sides = new Parser(tokenize(text)).equation();
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: 'parse', message: e.message };
    throw e;
  }
  const canonical = sides.map(format).join(' = ');
  const numbers = sides.flatMap((s) => numbersIn(s));
  if (sides.length < 2) {
    return { ok: false, error: 'no-equals', message: 'Add an = so there are two sides', canonical, numbers };
  }
  let values: Value[];
  try {
    values = sides.map(evaluate);
  } catch (e) {
    if (e instanceof MathError) return { ok: false, error: e.code, message: e.message, canonical, numbers };
    throw e;
  }
  const texts = values.map(valueText);
  if (!values.every((v) => equal(v, values[0]))) {
    return {
      ok: false,
      error: 'not-true',
      message: `Not true yet: the sides are ${texts.join(' and ')}`,
      canonical,
      numbers,
      values: texts
    };
  }
  return { ok: true, canonical, sides, value: texts.find((t) => !t.startsWith('≈')) ?? texts[0], numbers };
}

/**
 * The light check's second half: every number in the math must be one of the sign's numbers,
 * each used no more often than the sign shows it. Returns the numbers that don't match.
 */
export function numbersNotOnSign(used: string[], onSign: string[]): string[] {
  const left = new Map<string, number>();
  for (const n of onSign) {
    const k = normalizeNumber(n);
    left.set(k, (left.get(k) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const n of used) {
    const k = normalizeNumber(n);
    const count = left.get(k) ?? 0;
    if (count > 0) left.set(k, count - 1);
    else missing.push(n);
  }
  return missing;
}
