import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const contracts = path.join(root, 'docs', 'spec', 'contracts');
const configuration = ts.readConfigFile(path.join(contracts, 'tsconfig.json'), ts.sys.readFile);
if (configuration.error)
  throw new Error(ts.flattenDiagnosticMessageText(configuration.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, contracts);
const options = { ...parsed.options, customConditions: ['source'] };
const host = ts.createCompilerHost(options);
const implementations = new Map([
  [path.join(contracts, 'builder'), path.join(root, 'packages', 'device-model', 'src', 'index.ts')],
  [path.join(contracts, 'ir'), path.join(root, 'packages', 'device-model', 'src', 'index.ts')],
  [path.join(contracts, 'host'), path.join(root, 'packages', 'simulator', 'src', 'index.ts')],
]);

host.resolveModuleNameLiterals = (modules, containingFile) =>
  modules.map(({ text }) => {
    const implementation = implementations.get(path.resolve(path.dirname(containingFile), text));
    if (implementation) {
      return { resolvedModule: { resolvedFileName: implementation, extension: ts.Extension.Ts } };
    }
    return ts.resolveModuleName(text, containingFile, options, host);
  });

const program = ts.createProgram(parsed.fileNames, options, host);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    }),
  );
  process.exitCode = 1;
} else {
  console.log(
    'Existing Builder/IR/host type scenarios passed against the real implementation exports.',
  );
}
