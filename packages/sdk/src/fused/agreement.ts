/**
 * Cross-check of a compiled model IR against its manifest (RFC 0020 / RFC 0021).
 *
 * The rules mirror the SDK build (`build/unified-manifest.ts` `assertModelAgreement`), so a package
 * the build accepts is accepted here and a hand-written module cannot quietly disagree with its
 * manifest: pin sets are equal, every DDL property is declared with an equivalent type, the same
 * nullability, the same enum members and the same default value. Defaults are evaluated with the
 * build's own pure evaluator, so a default it can prove is proven here and a default it cannot
 * prove is rejected explicitly instead of being trusted.
 */
import type { ComputationIR, DeviceIR } from '@mica-js/device-model';
import type { UnifiedDeviceManifest } from '@mica-js/document/fused';
import { evaluateConstant } from '../build/unified-defaults.js';
import { problem } from './diagnostics.js';
import type { PreparationProblem } from './diagnostics.js';

/** Manifest property types an IR property kind may map onto; identical to the build's table. */
const IR_PROPERTY_TYPES: Readonly<Record<string, readonly string[]>> = {
  number: ['number', 'integer'],
  string: ['string', 'color'],
  bool: ['boolean'],
  bytes: ['binary', 'image'],
};

/** Returns every disagreement between the manifest and the model IR. */
export function checkModelAgreement(
  manifest: UnifiedDeviceManifest,
  model: DeviceIR,
): PreparationProblem[] {
  const problems: PreparationProblem[] = [];
  const add = (message: string, pointer: string): void => {
    problems.push(problem('model/invalid-interface', message, pointer));
  };

  const irPins = model.declarations.flatMap((declaration) =>
    declaration.kind === 'pin' ? [declaration.name] : [],
  );
  const manifestPins = Object.keys(manifest.pins ?? {});
  const missing = irPins.filter((pin) => !manifestPins.includes(pin));
  const undeclared = manifestPins.filter((pin) => !irPins.includes(pin));
  if (missing.length > 0 || undeclared.length > 0) {
    add(
      `Pins of ${manifest.publisher}:${manifest.name} differ between manifest and model IR ` +
        `(model only: ${missing.join(', ') || 'none'}; manifest only: ${undeclared.join(', ') || 'none'}).`,
      '/pins',
    );
  }

  const properties = manifest.properties ?? {};
  // DDL `const` declarations stay available to a default expression.
  const constants = new Map<string, ComputationIR>(
    model.declarations.flatMap((declaration) =>
      declaration.kind === 'const' ? [[declaration.name, declaration.value] as const] : [],
    ),
  );
  const enums = new Map(
    model.declarations.flatMap((declaration) =>
      declaration.kind === 'enum' ? [[declaration.name, declaration.members] as const] : [],
    ),
  );

  for (const declaration of model.declarations) {
    if (declaration.kind !== 'property') {
      continue;
    }
    const pointer = `/properties/${declaration.name}`;
    const descriptor = properties[declaration.name];
    if (descriptor === undefined) {
      add(
        `The model IR declares the property "${declaration.name}" the manifest does not describe.`,
        pointer,
      );
      continue;
    }
    const optional = declaration.type.kind === 'optional';
    const plain = optional ? declaration.type.inner : declaration.type;

    if (plain.kind === 'enum') {
      if (descriptor.type !== 'enum') {
        add(
          `Property "${declaration.name}" is an enum in the model IR but ${descriptor.type} in the manifest.`,
          pointer,
        );
      } else {
        const expected = [...(enums.get(plain.name) ?? [])].sort().join('\u0000');
        const actual = (descriptor.options ?? [])
          .map((option) => option.value)
          .sort()
          .join('\u0000');
        if (expected !== actual) {
          add(
            `Options of property "${declaration.name}" must match the model enum members.`,
            pointer,
          );
        }
      }
    } else if (!IR_PROPERTY_TYPES[plain.kind]?.includes(descriptor.type)) {
      add(
        `Property "${declaration.name}" is ${plain.kind} in the model IR but ${descriptor.type} in the manifest.`,
        pointer,
      );
    }

    if (optional !== (descriptor.nullable === true)) {
      add(
        optional
          ? `Property "${declaration.name}" is optional in the model IR but the manifest does not set nullable.`
          : `Property "${declaration.name}" is not optional in the model IR but the manifest sets nullable.`,
        pointer,
      );
    }

    const hasDefault = Object.hasOwn(descriptor, 'default');
    // Both sides must agree on whether a default exists at all (same rule as the SDK build).
    if ((declaration.default === undefined) === hasDefault) {
      add(
        declaration.default === undefined
          ? `The manifest declares a default for "${declaration.name}" the model IR does not.`
          : `The model IR declares a default for "${declaration.name}" the manifest does not.`,
        `${pointer}/default`,
      );
      continue;
    }
    if (declaration.default === undefined) {
      continue;
    }
    const evaluation = evaluateConstant(declaration.default, constants);
    if (!evaluation.known) {
      add(
        `The default of "${declaration.name}" cannot be verified before a factory runs: ${evaluation.reason}.`,
        `${pointer}/default`,
      );
      continue;
    }
    if (!sameValue(evaluation.value, descriptor.default)) {
      add(
        `The manifest default of "${declaration.name}" must equal the model IR default.`,
        `${pointer}/default`,
      );
    }
  }

  return problems;
}

/** Equality used by the build: `Object.is` for numbers, deep data comparison otherwise. */
function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return Object.is(left, right);
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => sameValue(item, right[index]));
  }
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) {
    return false;
  }
  return keys.every((key) =>
    sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}
