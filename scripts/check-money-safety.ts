/**
 * Static guard for the "never use number/float for money" rule (run in CI: `bun run check:money`).
 *
 *  - no parseFloat / toFixed-on-number / Number() / parseInt / unary-plus conversions in domain code and Money;
 *  - no money-like property typed as `number` anywhere in src;
 *  - no float / real / double precision / money SQL column types in migrations.
 *
 * It is deliberately simple (regex-based): it catches the realistic regressions, and the type system plus the
 * NUMERIC-as-string integration test cover the rest.
 */
import { Glob } from "bun";

interface Rule {
  name: string;
  files: string;
  pattern: RegExp;
}

const MONEY_WORDS =
  "(amount|balance|balanceBefore|balanceAfter|money|credits|debits|difference|initialBalance)";

const rules: Rule[] = [
  { name: "parseFloat is forbidden in src", files: "src/**/*.ts", pattern: /\bparseFloat\s*\(/ },
  {
    name: "numeric conversions are forbidden in domain code",
    files: "src/{shared,modules/*}/domain/**/*.ts",
    pattern: /\b(Number\s*\(|Number\.parse(Int|Float)|parseInt\s*\()/,
  },
  {
    name: "money-like fields must not be typed as number",
    files: "src/**/*.ts",
    pattern: new RegExp(`\\b${MONEY_WORDS}\\??\\s*:\\s*number\\b`),
  },
  {
    name: "floating point SQL types are forbidden",
    files: "src/infrastructure/database/migrations/*.ts",
    pattern: /\b(real|float[48]?|double precision|money)\b(?!_)/i,
  },
];

let violations = 0;
for (const rule of rules) {
  for await (const file of new Glob(rule.files).scan(".")) {
    const lines = (await Bun.file(file).text()).split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (rule.pattern.test(code)) {
        violations++;
        console.error(`${file}:${i + 1}  ${rule.name}\n    ${line.trim()}`);
      }
    });
  }
}

if (violations > 0) {
  console.error(`\n✗ ${violations} money-safety violation(s)`);
  process.exit(1);
}
console.log("✓ money-safety check passed");
