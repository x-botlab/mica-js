import { execSync } from 'node:child_process';

const run = (command) => {
  execSync(command, { stdio: 'inherit' });
};

run('pnpm -r --filter "./packages/*" build');

// publint / attw --pack run each package's prepack, which rebuilds dependencies.
// Serialize them so those nested builds never race on shared dist output.
run('pnpm --workspace-concurrency=1 -r --filter "./packages/*" exec publint');
run(
  'pnpm --workspace-concurrency=1 -r --filter "./packages/*" exec attw --pack . --profile esm-only',
);
