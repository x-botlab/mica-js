import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument, isMap, isScalar } from 'yaml';
import ts from 'typescript';

const sections = {
  compile: ['输入', '执行步骤', '断言'],
  simulation: ['模型', '装配', '执行步骤', '断言'],
  comparison: ['对照输入', '执行步骤', '断言'],
};
const knownSections = new Set(Object.values(sections).flat());
const metadataKeys = new Set(['format', 'id', 'kind']);

function filename(file) {
  return file instanceof URL ? fileURLToPath(file) : String(file ?? '<markdown>');
}

/** Trusted test code, not a sandbox. JSON inputs are objects; other inputs and
 * modelSource are verbatim DDL text. Models are not automatically compiled.
 * The caller must supply a real node:test context; it owns all t.after hooks.
 */
export async function loadMarkdownCase(fileURL, { layer } = {}) {
  return parseMarkdownCase(await readFile(fileURL, 'utf8'), { file: fileURL, layer });
}

export function parseMarkdownCase(source, { file, layer } = {}) {
  file = filename(file);
  const moduleBaseURL = pathToFileURL(file);
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const fail = (message, line = 1, section = 'frontmatter', cause) => {
    throw new Error(`${file}:${line} [${section}]: ${message}`, { cause });
  };
  if (lines[0] !== '---') fail('required YAML frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) fail('unterminated YAML frontmatter');
  const yamlSource = lines.slice(1, end).join('\n');
  const doc = parseDocument(yamlSource, { uniqueKeys: true, schema: 'core', strict: true });
  const yamlLine = (offset) => 2 + yamlSource.slice(0, offset ?? 0).split('\n').length - 1;
  if (doc.errors.length) {
    const error = doc.errors[0];
    fail(error.message, yamlLine(error.pos?.[0]), 'frontmatter', error);
  }
  if (doc.warnings.length) fail(doc.warnings[0].message, yamlLine(doc.warnings[0].pos?.[0]));
  if (!isMap(doc.contents)) fail('metadata must be a mapping');
  const metadata = {};
  const locations = {};
  for (const pair of doc.contents.items) {
    const key = pair.key;
    const line = yamlLine(key?.range?.[0]);
    if (!isScalar(key) || typeof key.value !== 'string' || !metadataKeys.has(key.value)) {
      fail('unknown metadata key', line);
    }
    locations[key.value] = line;
    const value = pair.value;
    if (!isScalar(value) || typeof value.value !== 'string') {
      fail(`${key.value} must be a string`, line);
    }
    metadata[key.value] = value.value;
  }
  const check = (key, valid, message) => {
    if (!valid) fail(message, locations[key] ?? 1);
  };
  check('format', metadata.format === 'mica-case/v1', 'format must be mica-case/v1');
  check(
    'id',
    typeof metadata.id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(metadata.id),
    'id must be lower-kebab',
  );
  check(
    'kind',
    Object.hasOwn(sections, metadata.kind),
    'kind must be compile, simulation or comparison',
  );

  const tree = fromMarkdown(lines.map((line, index) => (index <= end ? '' : line)).join('\n'));
  const required = sections[metadata.kind];
  const blocks = new Map();
  let section = '<preamble>';
  let next = 0;
  function text(node) {
    return node.value ?? node.children?.map(text).join('') ?? '';
  }
  function visit(node, topLevel = false) {
    const line = node.position?.start.line ?? 1;
    if (node.type === 'heading') {
      const title = text(node).trim();
      if (!topLevel || node.depth > 2) {
        if (required.includes(section) || knownSections.has(title))
          fail('nested headings cannot delimit executable sections', line, section);
      } else if (node.depth === 2) {
        section = title;
        if (knownSections.has(title)) {
          if (!required.includes(title))
            fail('section is not applicable to this kind', line, title);
          if (blocks.has(title)) fail('duplicate section', line, title);
          if (required[next] !== title)
            fail(`section order: expected ${required[next]}`, line, title);
          blocks.set(title, []);
          next++;
        }
      } else {
        section = '<preamble>';
      }
    }
    if (node.type === 'code' || node.type === 'inlineCode') {
      if (node.type === 'inlineCode') return;
      if (!required.includes(section)) fail('code in non-executable section', line, section);
      const marker = lines[line - 1].trimStart();
      if (!topLevel || !(marker.startsWith('```') || marker.startsWith('~~~')))
        fail('only top-level fenced code is allowed', line, section);
      if (!node.value.trim()) fail('empty code', line, section);
      blocks.get(section).push(node);
      if (blocks.get(section).length > 1)
        fail('exactly one fenced code block required', line, section);
    }
    for (const child of node.children ?? []) visit(child, node.type === 'root');
  }
  visit(tree);
  for (const name of required) {
    if (!blocks.has(name) || blocks.get(name).length !== 1)
      fail('missing section or fenced code block', lines.length, name);
  }
  const get = (name) => blocks.get(name)[0];
  for (const name of required) {
    const block = get(name);
    const languages =
      name === '装配'
        ? ['json']
        : ['执行步骤', '断言'].includes(name)
          ? ['typescript']
          : name === '模型'
            ? ['ddl']
            : ['ddl', 'json'];
    if (!languages.includes(block.lang) || block.meta)
      fail(`language must be ${languages.join('/')}`, block.position.start.line, name);
  }
  const json = (name) => {
    const block = get(name);
    try {
      return JSON.parse(block.value);
    } catch (cause) {
      fail('invalid JSON', block.position.start.line + 1, name, cause);
    }
  };
  const bindings = {};
  if (metadata.kind === 'simulation') {
    bindings.modelSource = get('模型').value;
    bindings.description = json('装配');
  } else {
    const name = metadata.kind === 'compile' ? '输入' : '对照输入';
    bindings[metadata.kind === 'compile' ? 'input' : 'inputs'] =
      get(name).lang === 'json' ? json(name) : get(name).value;
  }

  // Blank lines preserve Markdown coordinates before TypeScript's source map.
  const executable = Array(lines.length).fill('');
  for (const name of ['执行步骤', '断言']) {
    const block = get(name);
    block.value.split('\n').forEach((line, index) => {
      executable[block.position.start.line + index] = line;
    });
  }
  const wrapper = `(async function(adapter, assert, t, modelSource, description, input, inputs, importModule) {\n${executable.join('\n')}\n})`;
  const syntax = ts.createSourceFile(
    'markdown-case.ts',
    wrapper,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sectionAt = (line) =>
    ['执行步骤', '断言'].find((name) => {
      const block = get(name);
      return line > block.position.start.line && line < block.position.end.line;
    }) ?? '执行步骤';
  const syntaxFailure = (message, pos) => {
    const point = syntax.getLineAndCharacterOfPosition(pos);
    fail(message, point.line, sectionAt(point.line));
  };
  for (const diagnostic of syntax.parseDiagnostics)
    syntaxFailure(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      diagnostic.start ?? 0,
    );
  function inspect(node) {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      syntaxFailure(
        'import/export is not allowed; use injected dependencies',
        node.getStart(syntax),
      );
    }
    ts.forEachChild(node, inspect);
  }
  const functionNode = syntax.statements[0].expression.expression;
  inspect(functionNode.body);
  const compiled = ts.transpileModule(wrapper, {
    fileName: 'markdown-case.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
    },
  });
  for (const diagnostic of compiled.diagnostics ?? []) {
    if (diagnostic.category === ts.DiagnosticCategory.Error)
      syntaxFailure(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        diagnostic.start ?? 0,
      );
  }
  let execute;
  try {
    execute = new Script(compiled.outputText, { filename: file }).runInThisContext();
  } catch (cause) {
    fail(
      'invalid executable TypeScript',
      get('执行步骤').position.start.line + 1,
      '执行步骤',
      cause,
    );
  }
  const map = new SourceMap(JSON.parse(compiled.sourceMapText));
  return {
    id: metadata.id,
    layer,
    file,
    async run(adapter, t) {
      if (!t || typeof t.after !== 'function')
        fail('run requires a node:test context with t.after', 1, '执行步骤');
      const importLocations = new Map();
      const importModule = async (specifier) => {
        // Native loader errors may omit the awaiting Markdown frame.
        const location = new Error().stack;
        try {
          if (
            typeof specifier !== 'string' ||
            !(specifier.startsWith('./') || specifier.startsWith('../')) ||
            specifier.includes('\\')
          ) {
            throw new TypeError('importModule requires a relative ./ or ../ module specifier');
          }
          return await import(new URL(specifier, moduleBaseURL).href);
        } catch (cause) {
          importLocations.set(cause, location);
          throw cause;
        }
      };
      try {
        await execute(
          adapter,
          assert,
          t,
          bindings.modelSource,
          bindings.description,
          bindings.input,
          bindings.inputs,
          importModule,
        );
      } catch (cause) {
        const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const location = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(
          importLocations.get(cause) ?? cause?.stack ?? '',
        );
        const entry = location
          ? map.findEntry(Number(location[1]) - 1, Number(location[2]) - 1)
          : null;
        const line = entry?.originalLine ?? get('执行步骤').position.start.line + 1;
        fail(cause?.message ?? String(cause), line, sectionAt(line), cause);
      }
    },
  };
}
