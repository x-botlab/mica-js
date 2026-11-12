import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceMetadataSymbol, parseDeviceMetadata } from '@mica-js/document/schematic';
import { loadSourceDevice, readMetadata } from './harness.ts';

/**
 * 全器件一致性：元数据、DDL 与适配器必须描述同一组资源。
 *
 * 这里不做行为断言（各器件的 `test/<id>.test.ts` 负责），只保证三份声明不会互相漂移：
 * 属性名、引脚名、通道名与方向都必须对得上，符号能被文档解析器接受。
 */

const DEVICE_ROOT = join(import.meta.dirname, '..', 'src', 'devices');
const ids = readdirSync(DEVICE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

interface Declaration {
  readonly kind: string;
  readonly name?: string;
  readonly direction?: string;
}

describe('CT107D 器件清单', () => {
  it('至少包含 13 个器件目录', () => {
    expect(ids.length).toBeGreaterThanOrEqual(13);
  });

  for (const id of ids) {
    describe(id, () => {
      it('元数据与 DDL 的属性、引脚、端口一致', async () => {
        const metadata = readMetadata(id) as {
          readonly id: string;
          readonly properties?: Readonly<Record<string, unknown>>;
          readonly pins?: Readonly<Record<string, unknown>>;
          readonly ports?: Readonly<Record<string, { readonly direction: string }>>;
        };
        const device = await loadSourceDevice(id);
        const declarations = device.model.declarations as readonly Declaration[];
        const names = (kind: string): string[] =>
          declarations
            .filter((declaration) => declaration.kind === kind)
            .map((declaration) => declaration.name as string)
            .sort();

        expect(metadata.id).toBe(id);
        expect(Object.keys(metadata.properties ?? {}).sort()).toEqual(names('property'));
        expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(names('pin'));

        const ports = Object.entries(metadata.ports ?? {})
          .map(([name, port]) => `${name}:${port.direction}`)
          .sort();
        const channels = declarations
          .filter((declaration) => declaration.kind === 'channel')
          .map((declaration) => `${declaration.name}:${declaration.direction}`)
          .sort();

        expect(ports).toEqual(channels);
      });

      it('device.json 通过文档解析器，未声明 symbol 时按引脚生成', () => {
        const definition = parseDeviceMetadata(readMetadata(id));
        const symbol = deviceMetadataSymbol(definition);

        expect(Object.keys(symbol.pins).sort()).toEqual(
          Object.keys((readMetadata(id) as { pins?: object }).pins ?? {}).sort(),
        );
      });

      it('适配器源码不引用未导出的辅助模块', () => {
        const directory = join(DEVICE_ROOT, id);
        // JIT 器件（IAP15F2K61S2）由 `kernel/` 与 `peripherals/` 多个模块组成，
        // 构建器会把它们一起打包，因此只对单文件适配器检查自包含性。
        if (readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isDirectory()))
          return;
        const source = readFileSync(join(directory, 'index.ts'), 'utf8');

        // 组件产物必须自包含：只允许类型导入与本地 model.ddl 类型。
        for (const match of source.matchAll(/from\s+'([^']+)'/g))
          expect(['./model.ddl']).toContain(match[1]);
      });
    });
  }
});
