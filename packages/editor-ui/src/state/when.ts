/** The values of the context keys, by key (`engine.backend`, `tool.primary`). */
export type ContextKeyValues = Readonly<Record<string, unknown>>;

/** A `when` clause, compiled. */
export type WhenClause = (keys: ContextKeyValues) => boolean;

type Literal = string | number | boolean;

type Token =
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'op'; readonly text: string };

// A key or a bare value: letters, digits and . _ - (a key, an id, a number).
const word = /[\w.-]+/y;
const operators = ['&&', '||', '==', '!=', '!', '(', ')'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] ?? '';
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = source.indexOf(char, at + 1);
      if (end < 0) throw new SyntaxError(`Unclosed string in "${source}"`);
      tokens.push({ kind: 'string', text: source.slice(at + 1, end) });
      at = end + 1;
      continue;
    }
    const operator = operators.find((op) => source.startsWith(op, at));
    if (operator) {
      tokens.push({ kind: 'op', text: operator });
      at += operator.length;
      continue;
    }
    word.lastIndex = at;
    const match = word.exec(source);
    if (!match) {
      throw new SyntaxError(`Unexpected "${char}" in "${source}"`);
    }
    tokens.push({ kind: 'word', text: match[0] });
    at += match[0].length;
  }
  return tokens;
}

// The value of a bare word: a boolean, a number, else the word itself.
function literal(token: Token): Literal {
  if (token.kind === 'string') return token.text;
  if (token.text === 'true') return true;
  if (token.text === 'false') return false;
  const number = Number(token.text);
  return token.text !== '' && Number.isFinite(number) ? number : token.text;
}

/**
 * Compiles a `when` clause on the context keys (design/editor-ui.md §6), as
 * in VS Code: a key is true if its value is truthy; `key == value` and
 * `key != value` compare it to a value, bare (`engine.backend == vulkan`)
 * or quoted; `!`, `&&` (before `||`) and parentheses. Throws a SyntaxError
 * if the clause is not valid.
 */
export function compileWhen(source: string): WhenClause {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (text: string) => {
    const token = peek();
    return token?.kind === 'op' && token.text === text;
  };
  const fail = (): never => {
    const token = peek();
    throw new SyntaxError(
      token
        ? `Unexpected "${token.text}" in "${source}"`
        : `Unexpected end of "${source}"`,
    );
  };

  const or = (): WhenClause => {
    const terms = [and()];
    while (isOp('||')) {
      at++;
      terms.push(and());
    }
    return terms.length === 1
      ? (terms[0] as WhenClause)
      : (keys) => terms.some((term) => term(keys));
  };
  const and = (): WhenClause => {
    const terms = [unary()];
    while (isOp('&&')) {
      at++;
      terms.push(unary());
    }
    return terms.length === 1
      ? (terms[0] as WhenClause)
      : (keys) => terms.every((term) => term(keys));
  };
  const unary = (): WhenClause => {
    if (isOp('!')) {
      at++;
      const term = unary();
      return (keys) => !term(keys);
    }
    return primary();
  };
  const primary = (): WhenClause => {
    if (isOp('(')) {
      at++;
      const inner = or();
      if (!isOp(')')) fail();
      at++;
      return inner;
    }
    const token = peek();
    if (token?.kind !== 'word') return fail();
    at++;
    if (token.text === 'true') return () => true;
    if (token.text === 'false') return () => false;
    const key = token.text;
    for (const [op, equal] of [
      ['==', true],
      ['!=', false],
    ] as const) {
      if (!isOp(op)) continue;
      at++;
      const valueToken = peek();
      if (!valueToken || valueToken.kind === 'op') return fail();
      at++;
      const value = literal(valueToken);
      return (keys) => (keys[key] === value) === equal;
    }
    return (keys) => Boolean(keys[key]);
  };

  if (tokens.length === 0) return () => true;
  const clause = or();
  if (at < tokens.length) fail();
  return clause;
}

const compiled = new Map<string, WhenClause>();

/**
 * Whether the keys satisfy the clause, compiled once; true without a clause.
 * A clause that is not valid is false, with a warning.
 */
export function matchesWhen(
  source: string | undefined,
  keys: ContextKeyValues,
): boolean {
  if (source === undefined) return true;
  let clause = compiled.get(source);
  if (!clause) {
    try {
      clause = compileWhen(source);
    } catch (error) {
      console.warn('[editor]', (error as Error).message);
      clause = () => false;
    }
    compiled.set(source, clause);
  }
  return clause(keys);
}
