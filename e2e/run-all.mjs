// e2e/run-all.mjs — run build-output tests then SW e2e tests.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
    p.on('close', (code) => resolve(code));
  });
}

const buildCode = await run('build.test.mjs');
if (buildCode !== 0) {
  console.log('\nbuild tests failed; skipping SW e2e.');
  process.exit(1);
}
const swCode = await run('sw.test.mjs');
process.exit(swCode === 0 ? 0 : 1);
