declare module 'semver' {
  export function validRange(range: string): string | null;
  export function parse(version: string): { readonly raw: string } | null;
  export function satisfies(
    version: string,
    range: string,
    options?: { readonly includePrerelease?: boolean },
  ): boolean;
}
