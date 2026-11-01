import { expect, test } from "bun:test";
import { resolve, sep } from "node:path";

test("domain imports stay inside their module or shared/domain, with no money coercion", async () => {
  const files = [...new Bun.Glob("src/**/domain/**/*.ts").scanSync(".")];
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = await Bun.file(file).text();
    const module = file.split("/")[1];
    for (const match of source.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const imported = match[1];
      if (!imported) throw new Error("Missing import");
      expect(imported, file).not.toMatch(/@nestjs|@mikro-orm|@aws-sdk|^jose$|^pino$/);
      const target = resolve(file, "..", imported);
      expect(
        target.startsWith(resolve("src", module ?? "", "domain") + sep) ||
          target.startsWith(resolve("src/shared/domain") + sep),
        file,
      ).toBe(true);
    }
    expect(source, file).not.toMatch(/\b(?:parseFloat|Number)\s*\(|\.toFixed\s*\(/);
  }
});
