import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { types } from '../../../packages/device-model/dist/index.js';
import { createProcessor } from './minimal-processor/minimal-processor-adapter.js';

const source = await readFile(
  new URL('./minimal-processor/minimal-processor.ts', import.meta.url),
  'utf8',
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const processor = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

export const { processorCases } = processor;

export function observedProcessor(adapter) {
  const builder = adapter.createDeviceBuilder();
  builder.memory({ name: 'evidence', length: 6, public: true });
  for (const [offset, name] of ['acc', 'pc', 'returnPc'].entries()) {
    builder.on({ name: `observe_${name}`, sourcePath: [name] }, (body) => {
      body.store8('evidence', offset, body.readState(name, types.number));
    });
  }
  for (const [offset, name] of ['irqPending', 'irqEnabled', 'wakeLatched'].entries()) {
    builder.on({ name: `observe_${name}`, sourcePath: [name] }, (body) => {
      body.if(
        body.readState(name, types.bool),
        (yes) => yes.store8('evidence', offset + 3, 1),
        (no) => no.store8('evidence', offset + 3, 0),
      );
    });
  }
  return processor.buildProcessor(builder, types);
}

export function processorFactory({ contexts, translations, disposed, afterSync = () => {} }) {
  const translate = processor.createProcessorTranslator(types);
  return (context) => {
    contexts.push(context);
    const paired = createProcessor(context, (input, builder) => {
      translations.push({ pc: input.pc, code: [...input.code] });
      return translate(input, builder);
    });
    return {
      sync(batch) {
        paired.sync(batch);
        afterSync(context, batch);
      },
      dispose() {
        disposed.push(context);
        paired.dispose();
      },
    };
  };
}
