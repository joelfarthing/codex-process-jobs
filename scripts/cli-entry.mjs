import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node resolves the ESM main-module URL through symlinks (macOS /var -> /private/var,
// symlinked install prefixes), and file URLs percent-encode spaces, so neither a raw
// `file://${argv[1]}` comparison nor a plain path comparison is reliable. Compare
// canonical real paths and fail closed.
export function isCliEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const entryPath = path.resolve(argv1);
  if (entryPath === modulePath) return true;
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}
