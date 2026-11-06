import type { Rule, RuleHit } from '../types.js';
import { braceBlock, C_LIKE, eachLine, JS_TS } from './helpers.js';

/** Error handling (spec §2.1, §12.2): errors that disappear without a trace. */

const ONLY_LOGGING = /^\s*(console\.(log|error|warn|info|debug)|logger\.\w+|log\.\w+|this\.logger\.\w+|print|logging\.\w+|System\.out\.println|fmt\.Print\w*)\s*\(/;

export const emptyCatch: Rule = {
  id: 'errors.empty-catch',
  version: '1.0.0',
  category: 'error-handling',
  source: 'static',
  severity: 'P2',
  confidence: 0.9,
  languages: [...C_LIKE, 'python'],
  files: 'all',
  title: 'Exception swallowed silently',
  why: 'An empty catch hides failures: the program goes on in a broken state and nobody learns why.',
  fix: 'Handle the error, rethrow it with context, or, if ignoring it is right, say why in a comment inside the block.',
  examples: {
    language: 'typescript',
    positive: ['try { run(); } catch {}', 'try {\n  run();\n} catch (error) {\n}'],
    negative: ['try { run(); } catch (error) { throw new Error(`run failed: ${error}`); }', 'try {\n  run();\n} catch {\n  // The file may not exist yet; the default is used then.\n}'],
  },
  exceptions: 'A catch whose body is a comment explaining why the error is ignored.',
  check: (context) => {
    if (context.language === 'python') {
      return eachLine(context, /^\s*except\b[^:]*:\s*(pass)?\s*$/, (match, line, text) => {
        const next = (context.lines[line] ?? '').trim();
        return match[1] === 'pass' || next === 'pass' ? { line, lineEnd: match[1] === 'pass' ? line : line + 1, evidence: text.trim() } : null;
      });
    }
    const hits: RuleHit[] = [];
    context.lines.forEach((text, index) => {
      const line = index + 1;
      const at = text.search(/\bcatch\s*(\([^)]*\))?\s*\{/);
      if (at < 0) return;
      const rest = text.slice(at);
      if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(rest)) {
        hits.push({ line, evidence: text.trim() });
        return;
      }
      if (!/\{\s*$/.test(rest)) return;
      const block = braceBlock(context, line, 20, at);
      if (block !== null && block.body.every((body) => body.trim() === '')) hits.push({ line, lineEnd: block.end, evidence: text.trim() });
    });
    return hits;
  },
};

export const catchOnlyLogs: Rule = {
  id: 'errors.catch-only-logs',
  version: '1.0.0',
  category: 'error-handling',
  source: 'static',
  severity: 'P3',
  confidence: 0.6,
  languages: [...C_LIKE, 'python'],
  files: 'code',
  title: 'Exception only logged, then ignored',
  why: 'Logging and carrying on turns an error into a silent wrong result for the caller; the log line is easily missed.',
  fix: 'After logging, rethrow, return an error result, or recover explicitly so the caller knows.',
  examples: {
    language: 'typescript',
    positive: ['try {\n  save();\n} catch (error) {\n  console.error(error);\n}'],
    negative: ['try {\n  save();\n} catch (error) {\n  console.error(error);\n  throw error;\n}', 'try {\n  save();\n} catch (error) {\n  return { ok: false, error };\n}'],
  },
  exceptions: 'Blocks that also rethrow, return or otherwise act.',
  check: (context) => {
    if (context.language === 'python') {
      return eachLine(context, /^(\s*)except\b[^:]*:\s*$/, (match, line, text) => {
        const indent = (match[1] ?? '').length;
        const body: string[] = [];
        for (let current = line + 1; current <= context.lines.length; current += 1) {
          const next = context.lines[current - 1] ?? '';
          if (next.trim() === '') continue;
          if (next.length - next.trimStart().length <= indent) break;
          body.push(next);
        }
        return body.length > 0 && body.length <= 3 && body.every((statement) => ONLY_LOGGING.test(statement)) ? { line, evidence: text.trim() } : null;
      });
    }
    const hits: RuleHit[] = [];
    context.lines.forEach((text, index) => {
      const line = index + 1;
      const at = text.search(/\bcatch\s*(\([^)]*\))?\s*\{\s*$/);
      if (at < 0) return;
      const block = braceBlock(context, line, 12, at);
      if (block === null) return;
      const statements = block.body.filter((body) => body.trim() !== '' && !/^\s*\/\//.test(body));
      if (statements.length > 0 && statements.length <= 3 && statements.every((statement) => ONLY_LOGGING.test(statement))) hits.push({ line, lineEnd: block.end, evidence: text.trim() });
    });
    return hits;
  },
};

export const promiseCatchNoop: Rule = {
  id: 'errors.promise-catch-noop',
  version: '1.0.0',
  category: 'error-handling',
  source: 'static',
  severity: 'P2',
  confidence: 0.85,
  languages: JS_TS,
  files: 'code',
  title: 'Promise rejection swallowed',
  why: '`.catch(() => {})` drops every rejection, including the ones nobody expected.',
  fix: 'Handle the specific failure, or let it propagate; if dropping it is intended, say why next to it.',
  examples: {
    language: 'typescript',
    positive: ['void refresh().catch(() => {});', 'load().catch((error) => {});', 'await write().catch(() => {}); // TODO'],
    negative: ['load().catch((error) => report(error));', 'load().catch(() => {}); // best effort: the cache refills on the next poll', 'const decision = await ask(request).catch(() => null);'],
  },
  exceptions: 'A trailing comment on the same line that explains why, and a fallback value (`.catch(() => null)`) the caller then handles.',
  // A trailing comment counts as the reason, unless it is only a TODO marker.
  check: (context) =>
    eachLine(context, /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/, (_match, line, text) => (/\/\/\s*(?!(?:TODO|FIXME|XXX|HACK)\b\W*$)\S{3,}/i.test(text) ? null : { line, evidence: text.trim() })),
};

export const ERROR_PACK: readonly Rule[] = [emptyCatch, catchOnlyLogs, promiseCatchNoop];
