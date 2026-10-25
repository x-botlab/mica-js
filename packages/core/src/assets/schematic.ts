import type { Diagnostic } from '../format/diagnostics';
import { throwIfErrors } from '../format/errors';
import type { SchematicDocument } from '../format/types';
import { isAssetReference } from '../format/value';
import { report } from '../format/validate';
import { parseSchematic } from '../schematic/format/parse-schematic';
import { isAssetError, type AssetError } from './errors';
import { resolveAsset, type AssetResolverOptions } from './resolver';

/**
 * Resolves every `file` resource reference in a parsed schematic against the project root
 * (RFC 0009 §3).
 *
 * `inline` payloads are already base64-checked by the document format and `store` references
 * address a host-specific library, so neither touches the file system here. A repeated `src` is
 * resolved once, while every property that uses a broken reference still gets its own diagnostic.
 */
export async function validateSchematicAssets(
  document: SchematicDocument,
  options: AssetResolverOptions,
): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const resolutions = new Map<string, AssetError | null>();
  for (const [symbolIndex, symbol] of document.sheet.symbols.entries()) {
    const properties = symbol.properties;
    if (properties === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(properties)) {
      if (!isAssetReference(value) || value.mode !== 'file') {
        continue;
      }
      let failure = resolutions.get(value.src);
      if (failure === undefined) {
        const result = await resolveAsset(value.src, options);
        failure = isAssetError(result) ? result : null;
        resolutions.set(value.src, failure);
      }
      if (failure !== null) {
        report(diagnostics, failure.code, failure.message, [
          'sheet',
          'symbols',
          String(symbolIndex),
          'properties',
          key,
        ]);
      }
    }
  }
  return diagnostics;
}

/**
 * Parses a schematic and resolves all of its project files before returning it.
 *
 * @throws {SchematicError} when the document or any referenced asset is invalid.
 */
export async function parseSchematicWithAssets(
  input: string | unknown,
  options: AssetResolverOptions,
): Promise<SchematicDocument> {
  const document = parseSchematic(input);
  throwIfErrors(await validateSchematicAssets(document, options));
  return document;
}
