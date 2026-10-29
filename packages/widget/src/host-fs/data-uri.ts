/**
 * Decodes a self-contained `data:` URI to its bytes.
 *
 * `data:` resources never reach `HostFs`: the bytes travel with the reference, so the host decodes
 * them locally. `;base64` payloads are decoded from base64; other payloads are percent-decoded,
 * while characters that need no escaping are encoded as UTF-8. The URI fragment is ignored.
 *
 * @throws TypeError when the URI has no payload separator or the payload is not decodable.
 */
export function decodeDataUri(uri: string): Uint8Array {
  const { base64, payload } = splitDataUri(uri);
  return base64 ? decodeBase64(payload) : decodePercentPayload(payload);
}

/**
 * Decodes a self-contained `data:` URI to its text payload.
 *
 * The decoded bytes are read as UTF-8, so a payload that carries binary or malformed UTF-8 is a
 * decode failure rather than replacement characters.
 *
 * @throws TypeError when the URI has no payload separator, the payload is not decodable, or the
 * bytes are not UTF-8.
 */
export function decodeDataUriText(uri: string): string {
  const bytes = decodeDataUri(uri);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new TypeError('Data URI payload is not valid UTF-8', { cause });
  }
}

interface DataUriPayload {
  readonly base64: boolean;
  readonly payload: string;
}

/** Splits the URI into its `;base64` flag and payload. */
function splitDataUri(uri: string): DataUriPayload {
  if (uri.slice(0, 5).toLowerCase() !== 'data:') {
    throw new TypeError('Not a data: URI');
  }
  const hash = uri.indexOf('#');
  const body = hash < 0 ? uri : uri.slice(0, hash);
  const comma = body.indexOf(',');
  if (comma < 0) {
    throw new TypeError('Data URI must separate its payload with a comma');
  }

  const metadata = body.slice('data:'.length, comma);
  return { base64: /;base64$/i.test(metadata), payload: body.slice(comma + 1) };
}

function decodeBase64(payload: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(payload);
  } catch (cause) {
    throw new TypeError('Data URI payload is not valid base64', { cause });
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isHexDigit(value: string | undefined): value is string {
  return value !== undefined && /^[0-9A-Fa-f]$/.test(value);
}

/**
 * Percent-decodes a payload to bytes, so `%89PNG` keeps its binary value instead of being read as
 * (invalid) UTF-8. Literal characters are UTF-8 encoded.
 */
function decodePercentPayload(payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let literal = 0;
  let index = 0;

  while (index < payload.length) {
    if (payload[index] !== '%') {
      index += 1;
      continue;
    }
    const high = payload[index + 1];
    const low = payload[index + 2];
    if (!isHexDigit(high) || !isHexDigit(low)) {
      throw new TypeError('Data URI payload is not valid percent-encoding');
    }
    if (index > literal) chunks.push(encoder.encode(payload.slice(literal, index)));
    chunks.push(new Uint8Array([Number.parseInt(`${high}${low}`, 16)]));
    index += 3;
    literal = index;
  }

  if (literal < payload.length) chunks.push(encoder.encode(payload.slice(literal)));

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
