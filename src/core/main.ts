import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * True when this module is the entry point.
 *
 * The usual `import.meta.url === \`file://${process.argv[1]}\`` trick is broken
 * on Windows: `import.meta.url` is a properly encoded three-slash file URL
 * (`file:///D:/Razorpay%20Buildathon/...`) while `process.argv[1]` is a plain
 * backslash path. Decode one into the other instead of string-building.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(importMetaUrl)) === resolve(entry);
  } catch {
    return false;
  }
}
