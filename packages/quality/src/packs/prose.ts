import type { Rule, RuleHit } from '../types.js';
import { C_LIKE, eachLine, isCode, JS_TS, words } from './helpers.js';

/**
 * Naming and prose (Harry-inspired): what an agent writes for people to read. Each rule
 * checks only changed lines and stays quiet where a project's convention could reasonably differ.
 */

/**
 * A statement, not a sentence: a keyword start, an assignment, a call, or a lone brace. A sentence
 * that merely ends with a semicolon (prose in block comments) is not code.
 */
const CODE_IN_COMMENT = /^(?:(?:const|let|var|return|import|export|function|def|class|await|if\s*\(|for\s*\(|while\s*\()\b.*|[\w.$[\]'"]+\s*(?:=|\+=|-=|\*=)\s*[^=].*[;)\]}]\s*$|[\w.$]+\(.*\);?\s*$|\}\s*$)/;
const NOT_CODE = /^(eslint|@ts-|prettier|istanbul|c8|noqa|type:|pylint|TODO|FIXME|NOTE|HACK|XXX|e\.g\.|i\.e\.|see |https?:)/i;

export const commentedOutCode: Rule = {
  id: 'prose.commented-out-code',
  version: '1.0.0',
  category: 'comments',
  source: 'static',
  severity: 'P3',
  confidence: 0.7,
  languages: [...C_LIKE, 'python', 'ruby'],
  files: 'all',
  title: 'Commented-out code',
  why: 'Dead code in comments goes stale, misleads readers and hides what the code really does; version control keeps old code.',
  fix: 'Delete the commented-out code (Git keeps it), or explain in prose why it matters.',
  examples: {
    language: 'typescript',
    positive: ['// const total = items.reduce((sum, item) => sum + item.price, 0);', '// return cache.get(key);', '// user.name = input.trim();', '// renderAll(items);'],
    negative: [
      '// The cache is warmed on start, so the first request is fast.',
      '// eslint-disable-next-line no-console',
      '// See https://example.com/docs',
      ' * HttpOnly, SameSite=Strict session cookie;',
      '// 1. the user runs `jerry ui`; the CLI (token-authenticated) asks Core for a code;',
    ],
  },
  exceptions: 'Linter and type-checker directives, links, TODO notes, and comments that read as prose.',
  check: (context) =>
    eachLine(context, /.*/, (_match, line) => {
      const comment = context.comment(line);
      if (comment === null || comment === '' || NOT_CODE.test(comment)) return null;
      // Prose ends with a full stop and has spaces between plain words.
      if (/^[A-Z][^;{}()=]*[.!?:]$/.test(comment)) return null;
      return CODE_IN_COMMENT.test(comment) && /[=();{}]/.test(comment) ? { line, evidence: comment } : null;
    }),
};

/**
 * `result` and `info` stay off the list: right after the call that returns them they are idiomatic
 * (calibrated on JERRY's own code).
 */
const VAGUE = ['data', 'temp', 'tmp', 'obj', 'val', 'foo', 'bar', 'stuff', 'thing', 'item2', 'x1'];

export const vagueName: Rule = {
  id: 'naming.vague-name',
  version: '1.0.0',
  category: 'naming',
  source: 'static',
  severity: 'P4',
  confidence: 0.55,
  languages: [...JS_TS, 'python'],
  files: 'code',
  title: 'Vague name',
  why: 'Names like data, temp or obj say nothing about what the value is, so every reader has to work it out again.',
  fix: 'Name the value after what it holds (e.g. `invoices`, `retryDelayMs`, `parsedConfig`).',
  examples: { language: 'typescript', positive: ['const data = await fetchUsers();', 'let temp = a + b;'], negative: ['const users = await fetchUsers();', 'const metadata = read();', 'const result = spawnSync(binary, args);'] },
  exceptions: 'Test files; names that only contain one of these words (metadata); `result` and `info` right after the call that returns them.',
  check: (context) => {
    const declaration = context.language === 'python' ? new RegExp(`^\\s*(${VAGUE.join('|')})\\s*=[^=]`) : new RegExp(`\\b(?:const|let|var)\\s+(${VAGUE.join('|')})\\s*(?::[^=]+)?=`);
    return eachLine(context, declaration, (match, line, text) => ({ line, evidence: text.trim(), title: `Vague name "${match[1]}"` }));
  },
};

const BOOLEAN_PREFIX = /^(is|has|can|should|was|were|will|did|does|needs?|allow|allows|enable|enabled|disable|show|use|include|skip|must|may|want|wants|are|keep|force|dry|hide|ignore|only|any|all)/i;

export const booleanName: Rule = {
  id: 'naming.boolean-intent',
  version: '1.0.0',
  category: 'naming',
  source: 'static',
  severity: 'P4',
  confidence: 0.55,
  languages: JS_TS,
  files: 'code',
  title: 'Boolean name does not express intent',
  why: 'A boolean named flag, status or check does not say what is true; conditions using it read ambiguously.',
  fix: 'Name it as a yes/no question: `isVisible`, `hasAccess`, `shouldRetry`.',
  examples: { language: 'typescript', positive: ['let flag = false;', 'const status: boolean = true;'], negative: ['let isReady = false;', 'const hasAccess = true;', 'const count = 0;'] },
  exceptions: 'Names that already start with a question word (is, has, can, should, …).',
  check: (context) =>
    eachLine(context, /\b(?:const|let|var)\s+(\w+)\s*(?::\s*boolean\s*)?=\s*(?:true|false)\s*[;,)]?\s*$/, (match, line, text) => {
      const name = match[1] ?? '';
      if (BOOLEAN_PREFIX.test(name)) return null;
      return /^(flag|status|check|state|value|bool|boolean|ok|done|mode|switch)$|flag$/i.test(name) ? { line, evidence: text.trim(), title: `Boolean "${name}" does not say what is true` } : null;
    }),
};

const TIME_NAME = /\b(?:const|let|var|private|public|readonly)?\s*(timeout|delay|interval|ttl|duration|wait|expiry|expires|maxAge|retryDelay|backoff)\s*(?::\s*number\s*)?=\s*\d[\d_]*\s*[;,]?\s*$/i;
const UNIT_SUFFIX = /\b\w+(?:Ms|Millis|Milliseconds|Seconds|Secs|Sec|Minutes|Mins|Hours|Days|Bytes|Kb|Mb|_ms|_MS|_seconds|_SECONDS|_secs|_SECS|_bytes|_BYTES)\b/;

export const unitInName: Rule = {
  id: 'naming.missing-unit',
  version: '1.0.0',
  category: 'naming',
  source: 'static',
  severity: 'P4',
  confidence: 0.5,
  languages: [...JS_TS, 'python'],
  files: 'code',
  title: 'Time value without a unit in its name',
  why: 'A bare `timeout = 30` can mean seconds or milliseconds; mixing them is a classic source of bugs.',
  fix: 'Put the unit in the name (`timeoutMs`, `retryDelaySeconds`), as the file already does elsewhere.',
  examples: { language: 'typescript', positive: ['const RETRY_MS = 5;\nconst timeout = 3000;'], negative: ['const timeoutMs = 3000;', 'const timeout = 3000; // no unit names elsewhere'] },
  exceptions: 'Only where the file already names units elsewhere (the project convention); otherwise the rule stays quiet.',
  check: (context) => {
    // The project convention: some other identifier in the file carries a unit.
    if (!context.lines.some((text) => UNIT_SUFFIX.test(text))) return [];
    return eachLine(context, TIME_NAME, (match, line, text) => ({ line, evidence: text.trim(), title: `"${match[1]}" has no unit` }));
  },
};

const VAGUE_TODO = /^(fix|fix this|fix later|fix me|later|todo|refactor|cleanup|clean up|improve|hack|temp|temporary|change this|check|wip|\?+|\.\.\.)?\.?$/i;

export const vagueTodo: Rule = {
  id: 'prose.vague-todo',
  version: '1.0.0',
  category: 'comments',
  source: 'static',
  severity: 'P3',
  confidence: 0.8,
  languages: 'any',
  files: 'all',
  title: 'Empty or vague TODO',
  why: 'A TODO without what, why or who is never done: nobody knows what was left open.',
  fix: 'Say what is missing and why, ideally with an issue: `// TODO(#123): retry on 429 once the API sends Retry-After`.',
  examples: {
    language: 'typescript',
    positive: ['// TODO', '// FIXME: fix later', '/* TODO: refactor */', 'await save(); // TODO'],
    negative: ['// TODO(#42): paginate once the API supports cursors', '// TODO: handle the 429 response with a backoff', "const label = 'TODO list';"],
  },
  exceptions: 'TODOs with at least four words of explanation or an issue reference.',
  check: (context) =>
    eachLine(context, /.*/, (_match, line, text) => {
      // A whole-line comment, or a TODO comment at the end of a code line.
      const trailing = /(?:\/\/|#)\s*((?:TODO|FIXME|XXX|HACK)\b.*)$/i.exec(text);
      const comment = context.comment(line) ?? (trailing !== null && !/['"`][^'"`]*$/.test(text.slice(0, trailing.index)) ? trailing[1]! : null);
      if (comment === null) return null;
      const todo = /^(TODO|FIXME|XXX|HACK)\b[:(\s-]*(.*)$/i.exec(comment);
      if (todo === null) return null;
      const rest = (todo[2] ?? '').replace(/^[^)]*\)\s*:?\s*/, (prefix) => (/#\d+|[A-Z]+-\d+/.test(prefix) ? 'ISSUE ' : '')).trim();
      if (rest.startsWith('ISSUE')) return null;
      return VAGUE_TODO.test(rest) || words(rest).length < 3 ? { line, evidence: comment } : null;
    }),
};

const GENERIC_MESSAGE = /^(error|errors|failed|failure|fail|something went wrong|invalid|invalid input|oops|unknown error|an error occurred|error occurred|bad request|not found|unexpected error|exception)\.?!?$/i;

export const errorWithoutContext: Rule = {
  id: 'prose.error-without-context',
  version: '1.0.0',
  category: 'error-handling',
  source: 'static',
  severity: 'P3',
  confidence: 0.75,
  languages: [...C_LIKE, 'python', 'ruby'],
  files: 'code',
  title: 'Error message without context',
  why: 'A message like "Error" or "Invalid input" does not say what failed, with which value, or what to do; it costs time in every incident.',
  fix: 'Say what failed and with what: `throw new Error(`Cannot parse config ${file}: ${reason}`)`.',
  examples: { language: 'typescript', positive: ["throw new Error('Something went wrong');", 'throw new Error();', 'throw new ValidationError("Invalid input")'], negative: ['throw new Error(`Unknown task ${taskId}`);', "throw new Error('The plan has no steps; add at least one');", 'if (response.status === 401) throw new SignedOutError();'] },
  exceptions: 'Messages built from values, and messages longer than a generic phrase.',
  check: (context) =>
    eachLine(context, /\b(?:throw\s+new|raise)\s+\w*(?:Error|Exception)\s*\(\s*(?:(['"`])(.*?)\1)?\s*\)/, (match, line, text) => {
      const message = match[2];
      // A specific error class names the problem itself (`new SignedOutError()`); a bare Error does not.
      if (match[1] === undefined) return /\b(?:new|raise)\s+(?:Error|Exception|RuntimeError|ValueError|TypeError)\s*\(/.test(text) ? { line, evidence: text.trim(), title: 'Error without a message' } : null;
      return message !== undefined && !message.includes('${') && GENERIC_MESSAGE.test(message.trim()) ? { line, evidence: text.trim() } : null;
    }),
};

const STOP = new Set(['the', 'an', 'to', 'of', 'and', 'is', 'we', 'this', 'it', 'in', 'on', 'for', 'then', 'here', 'now', 'value', 'variable']);

export const commentRestatesCode: Rule = {
  id: 'prose.comment-restates-code',
  version: '1.0.0',
  category: 'comments',
  source: 'static',
  severity: 'P4',
  confidence: 0.5,
  languages: [...C_LIKE, 'python', 'ruby'],
  files: 'all',
  title: 'Comment repeats the code',
  why: 'A comment that says what the next line says adds reading time and drifts out of date; comments should say why.',
  fix: 'Remove it, or replace it with the reason behind the code.',
  examples: { language: 'typescript', positive: ['// increment counter\ncounter++;', '// return the user\nreturn user;'], negative: ['// Retries are capped: the API bans clients after five.\nretries++;', '// increment counter\n\nfoo();'] },
  exceptions: 'Comments with words the code does not contain (they explain something).',
  check: (context) => {
    const hits: RuleHit[] = [];
    context.lines.forEach((_text, index) => {
      const line = index + 1;
      const comment = context.comment(line);
      if (comment === null || !context.changed(line) || !isCode(context, line + 1)) return;
      // Section dividers (`// --- System ---`) are headings, not explanations.
      if (/[-=*#~_]{3,}/.test(comment)) return;
      const said = words(comment).filter((word) => !STOP.has(word));
      if (said.length === 0 || said.length > 5) return;
      const code = new Set(words(context.lines[line] ?? '').map((word) => word.replace(/s$/, '')));
      const synonyms: Record<string, string> = { increment: '', increase: '', decrement: '', add: '', get: '', set: '', call: '', create: 'new' };
      if (said.every((word) => code.has(word.replace(/s$/, '')) || (word in synonyms && /\+\+|--|\+=|-=|=|\(|new\b/.test(context.lines[line] ?? '')))) {
        hits.push({ line, evidence: comment });
      }
    });
    return hits;
  },
};

export const PROSE_PACK: readonly Rule[] = [commentedOutCode, vagueName, booleanName, unitInName, vagueTodo, errorWithoutContext, commentRestatesCode];
