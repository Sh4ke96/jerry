import { checkFile } from '../engine.js';
import type { CheckedFile, DetectedFinding, Rule, SecurityScanner } from '../types.js';
import { eachLine, JS_TS } from './helpers.js';

/**
 * Security checks (spec §12.2, ADR 0028): a first, conservative set of patterns behind the
 * SecurityScanner interface. Evidence never contains a secret value: it is masked before it is stored.
 */

export const dynamicEval: Rule = {
  id: 'security.dynamic-eval',
  version: '1.0.0',
  category: 'security',
  source: 'security',
  severity: 'P1',
  confidence: 0.8,
  languages: [...JS_TS, 'python', 'php', 'ruby'],
  files: 'code',
  title: 'Code built and run at runtime',
  why: 'eval, exec and new Function run whatever string reaches them; with any outside input that is remote code execution.',
  fix: 'Parse the data instead (JSON.parse, a lookup table, a real parser); never run strings as code.',
  examples: { language: 'typescript', positive: ['const value = eval(input);', "const run = new Function('a', body);"], negative: ['const value = JSON.parse(input);', 'evaluate(input);'] },
  exceptions: 'Method names that merely contain eval (evaluate, retrieval).',
  check: (context) => eachLine(context, context.language === 'python' ? /(?<![\w.])(?:eval|exec)\s*\(/ : /(?<![\w.])eval\s*\(|\bnew\s+Function\s*\(/),
};

export const shellInjection: Rule = {
  id: 'security.shell-injection',
  version: '1.0.0',
  category: 'security',
  source: 'security',
  severity: 'P1',
  confidence: 0.7,
  languages: [...JS_TS, 'python'],
  files: 'code',
  title: 'Shell command built from variables',
  why: 'A shell command assembled from strings lets a crafted value run extra commands (command injection).',
  fix: 'Pass arguments as an array without a shell (execFile/spawn with shell: false; subprocess.run([...]) without shell=True).',
  examples: { language: 'typescript', positive: ['execSync(`git log ${branch}`);', "exec('convert ' + file + ' out.png');"], negative: ["execFileSync('git', ['log', branch]);", "execSync('npm --version');"] },
  exceptions: 'Constant command strings without interpolation.',
  check: (context) =>
    context.language === 'python'
      ? eachLine(context, /\b(?:subprocess\.\w+\(.*shell\s*=\s*True|os\.system\(\s*(?:f['"]|.*\+|.*%|.*\.format\())/)
      : eachLine(context, /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]\s*\+|\w+\s*\+)/),
};

export const unsafeHtml: Rule = {
  id: 'security.unsafe-html',
  version: '1.0.0',
  category: 'security',
  source: 'security',
  severity: 'P2',
  confidence: 0.6,
  languages: [...JS_TS],
  files: 'code',
  title: 'HTML inserted without escaping',
  why: 'innerHTML, dangerouslySetInnerHTML and v-html render markup as-is; user-controlled text becomes cross-site scripting.',
  fix: 'Insert text (textContent, normal template binding) or sanitize with a vetted library first.',
  examples: { language: 'typescript', positive: ['element.innerHTML = message;', '<div dangerouslySetInnerHTML={{ __html: html }} />'], negative: ["element.innerHTML = '';", 'element.textContent = message;'] },
  exceptions: 'Clearing an element (`innerHTML = ""`).',
  check: (context) => eachLine(context, /\.(?:inner|outer)HTML\s*=\s*(?!\s*['"`]\s*['"`])|dangerouslySetInnerHTML|\bv-html\s*=/),
};

export const tlsDisabled: Rule = {
  id: 'security.tls-verification-off',
  version: '1.0.0',
  category: 'security',
  source: 'security',
  severity: 'P1',
  confidence: 0.85,
  languages: [...JS_TS, 'python'],
  files: 'code',
  title: 'TLS certificate checks turned off',
  why: 'Without certificate verification anyone on the network path can read and change the traffic.',
  fix: 'Keep verification on; trust a private CA by adding its certificate instead.',
  examples: { language: 'typescript', positive: ['const agent = new https.Agent({ rejectUnauthorized: false });', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"], negative: ['const agent = new https.Agent({ ca: corporateCa });'] },
  exceptions: 'None in production code; test files are not checked.',
  check: (context) => eachLine(context, context.language === 'python' ? /\bverify\s*=\s*False\b/ : /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/),
};

const SECRET_NAME = /\b([\w-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)[\w-]*)\s*['"]?\s*[:=]\s*(['"])([^'"\s]{8,})\2/i;
const PLACEHOLDER = /^(?:changeme|change-me|example|placeholder|dummy|sample|redacted|your[_-].*|<.*>|\$\{.*\}|\*+|x{4,}|\.{3,}|todo|null|undefined|none|password|secret)$/i;
/** PEM header of a private key, assembled so this file does not contain one. */
const PRIVATE_KEY = new RegExp(['-----BEGIN', ' (?:RSA |EC |OPENSSH |DSA )?', 'PRIVATE KEY', '-----'].join(''));

export const hardcodedSecret: Rule = {
  id: 'security.hardcoded-secret',
  version: '1.0.0',
  category: 'security',
  source: 'security',
  severity: 'P1',
  confidence: 0.7,
  languages: 'any',
  files: 'code',
  title: 'Secret written into the code',
  why: 'Secrets in source end up in Git history, logs and every copy of the repository; rotating them is the only fix.',
  fix: 'Read it from the environment or a secret store; rotate the exposed value.',
  examples: {
    language: 'typescript',
    // Built from fragments: the repository is scanned for secret-shaped literals.
    positive: [['const db', 'Pass', 'word = ', "'", 'Zq8m', 'N3vR', 'tx7L', "';"].join(''), ['api', '_key: "', 'k9Fq', '2LmZ', 'p0Rt', '"'].join('')],
    negative: ['const password = process.env.DB_PASSWORD;', "const apiKey = 'changeme';", "const passwordField = 'input';"],
  },
  exceptions: 'Placeholders (changeme, <…>, ${…}, ****), environment lookups and test files. The value is masked in the evidence.',
  check: (context) => [
    ...eachLine(context, SECRET_NAME, (match, line, text) => {
      const value = match[3] ?? '';
      if (PLACEHOLDER.test(value) || /^(?:process\.env|os\.environ|getenv)/.test(value)) return null;
      return { line, evidence: text.trim().replace(value, '***'), title: `Secret in "${match[1]}"` };
    }),
    ...eachLine(context, PRIVATE_KEY, (_match, line) => ({ line, evidence: 'private key block (masked)', title: 'Private key in the code' })),
  ],
};

export const SECURITY_PACK: readonly Rule[] = [dynamicEval, shellInjection, unsafeHtml, tlsDisabled, hardcodedSecret];

/** The built-in scanner behind the SecurityScanner interface. */
export const builtInSecurityScanner: SecurityScanner = {
  name: 'jerry-static-security',
  scan: (files: readonly CheckedFile[]): DetectedFinding[] => files.flatMap((file) => checkFile(file, SECURITY_PACK)),
};
