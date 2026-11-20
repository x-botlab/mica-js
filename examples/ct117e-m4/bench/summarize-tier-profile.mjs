import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const marker = /^ct117e_clear_(begin|end)_(\d+) :\d+:\d+$/;
const generated = /^(stepShard\d+|resumeShard\d+|outlined\d+|run) :\d+:\d+$/;
const ENTRY_LEAD_US = 50_000;
// CodeKind values and textual log format below are for the Node 24 benchmark.
const tierByKind = new Map([
  ['2', 'ignition'],
  ['9', 'ignition'],
  ['10', 'sparkplug'],
  ['11', 'maglev'],
  ['12', 'turbofan'],
]);

// V8 log records are processed in order: addresses may be moved, reused or deleted.
// Log all code ranges in the map (not just generated functions), so a new range can
// replace a stale generated range even when the replacing range is not of interest.
class CodeMap {
  #starts = [];
  #entries = new Map();

  #after(pc) {
    let lo = 0;
    let hi = this.#starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#starts[mid] <= pc) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get(pc) {
    const start = this.#starts[this.#after(pc) - 1];
    const entry = this.#entries.get(start);
    return entry && pc < start + entry.size ? entry : undefined;
  }

  delete(start) {
    if (this.#entries.delete(start)) this.#starts.splice(this.#after(start) - 1, 1);
  }

  set(start, entry) {
    const end = start + entry.size;
    const pos = this.#after(start);
    const prev = this.#starts[pos - 1];
    const first = prev !== undefined && prev + this.#entries.get(prev).size > start ? pos - 1 : pos;
    const last = this.#after(end - 1);
    const removed = this.#starts.splice(first, last - first, start);
    for (const address of removed) this.#entries.delete(address);
    this.#entries.set(start, { ...entry, start });
  }

  move(from, to) {
    const entry = this.#entries.get(from);
    if (!entry) return;
    this.delete(from);
    this.set(to, entry);
  }
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function decodeSource(source) {
  return source.replace(/\\(n|\\|x[\da-f]{2}|u[\da-f]{4})/gi, (_, escape) => {
    if (escape === 'n') return '\n';
    if (escape === '\\') return '\\';
    return String.fromCharCode(parseInt(escape.slice(1), 16));
  });
}

function deoptSource(entry, location, scripts) {
  const match = /^<unknown:(\d+):\d+>$/.exec(location);
  if (match) return scriptLine(entry, Number(match[1]), scripts);
}

function scriptLine(entry, line, scripts) {
  return scripts.get(entry.scriptId)?.split('\n')[line - 1]?.trim();
}

function dispatchSite(caller, returnPc, scripts) {
  const { scriptId, positions } = caller;
  const source = scripts.get(scriptId);
  if (!source || !positions) return;
  // The saved PC points just after the call. Ignore inlined positions, whose
  // source offset need not belong to the outer script.
  const pc = returnPc - caller.start - 1;
  let position;
  for (const match of positions.matchAll(/C(\d+)O(\d+)(?:F(-?\d+))?/g)) {
    if (Number(match[1]) > pc) break;
    position = match;
  }
  if (!position || position[3] !== undefined) return;
  const offset = Number(position[2]);
  const begin = source.lastIndexOf('\n', offset) + 1;
  const end = source.indexOf('\n', begin);
  const line = source.slice(begin, end < 0 ? undefined : end);
  return /^next = (D\d+)\(F, deadline, pc\); break;$/.exec(line)?.[1];
}

export async function summarize(path) {
  const code = new CodeMap();
  const scripts = new Map();
  const windows = [];
  let stateLoads = [];
  let current;

  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    // Keep source only for generated resident code, not the rest of the application.
    if (line.startsWith('script-source,')) {
      const script = /^script-source,(\d+),<unknown>,(.*)$/.exec(line);
      if (
        script &&
        ((script[2].includes('function run(F') && script[2].includes('return run;')) ||
          /^.{0,100}function stepShard\d+\(F/.test(script[2]))
      ) {
        scripts.set(script[1], decodeSource(script[2]));
      }
      continue;
    }
    if (!/^(code-(creation|move|delete|deopt|source-info)|tick|LoadIC),/.test(line)) continue;
    const [record, a, b, c, d, e, f, ...rest] = line.split(',');
    if (record === 'code-creation') {
      const kind = tierByKind.get(b);
      const fn = a === 'JS' && generated.exec(f)?.[1];
      const tier = fn && kind;
      const start = Number(d);
      const size = Number(e);
      if (size > 0) code.set(start, { size, fn, tier, rawName: f, builtin: a === 'Builtin' });

      // With --interpreted-frames-native-stack V8 emits both a trampoline
      // and a bytecode record for each marker; use only the bytecode record.
      const edge = a === 'JS' && b === '9' && marker.exec(f);
      if (edge) {
        const [, side, round] = edge;
        if (side === 'begin') {
          if (current) throw new Error(`Nested clear marker in ${path}`);
          const beginUs = Number(c);
          current = {
            round: Number(round),
            beginUs,
            bins: [],
            creation: [],
            deopts: [],
            frames: {},
            leaves: {},
            unclassifiedLeaves: Object.create(null),
            icCallers: {},
            icDispatchSites: {},
            frameStateLoads: stateLoads
              .filter(({ atUs }) => atUs >= beginUs - ENTRY_LEAD_US)
              .map((load) => ({ ...load, atUs: load.atUs - beginUs })),
          };
          stateLoads = [];
        } else {
          if (current?.round !== Number(round))
            throw new Error(`Mismatched clear marker in ${path}`);
          windows.push({ ...current, endUs: Number(c) });
          current = undefined;
        }
      } else if (current && tier && (tier === 'maglev' || tier === 'turbofan')) {
        current.creation.push({ atUs: Number(c) - current.beginUs, function: fn, tier });
      }
    } else if (record === 'code-source-info') {
      const start = Number(a);
      const entry = code.get(start);
      if (entry?.start === start && entry.tier && scripts.has(b)) {
        entry.scriptId = b;
        if (entry.fn === 'run') entry.positions = e;
      }
    } else if (record === 'code-move') {
      code.move(Number(a), Number(b));
    } else if (record === 'code-delete') {
      code.delete(Number(a));
    } else if (record === 'LoadIC' && rest[1] === 'states') {
      const entry = code.get(Number(a));
      if (!entry?.fn || !/^stepShard\d+$/.test(entry.fn)) continue;
      if (!scriptLine(entry, Number(c), scripts)?.startsWith('const S = F.states,')) continue;
      const atUs = Number(b);
      const load = {
        atUs,
        function: entry.fn,
        scriptId: entry.scriptId,
        from: e,
        to: f,
        map: rest[0],
      };
      if (current) current.frameStateLoads.push({ ...load, atUs: atUs - current.beginUs });
      else stateLoads.push(load);
    } else if (current && record === 'code-deopt') {
      const entry = code.get(Number(c));
      if (entry?.tier) {
        const location = rest[0];
        // Inlined frames can refer to another script at the same line number.
        const sourceLine =
          entry.fn !== 'run' && d === '-1' ? deoptSource(entry, location, scripts) : undefined;
        current.deopts.push({
          atUs: Number(a) - current.beginUs,
          function: entry.fn,
          tier: entry.tier,
          location,
          ...(sourceLine !== undefined ? { sourceLine } : {}),
          reason: rest.slice(1).join(','),
        });
      }
    } else if (current && record === 'tick') {
      const atUs = Number(b) - current.beginUs;
      if (atUs < 0) continue; // Some buffered ticks arrive after the begin marker.
      const slot = Math.floor(atUs / 5000);
      const bin = (current.bins[slot] ??= {});
      const external = Number(c) !== 0;
      const pc = Number(external ? d : a);
      const leaf = code.get(pc);
      let bucket = 'other';
      if (leaf?.tier) {
        bucket = `${leaf.fn === 'run' ? 'run' : 'shard'}:${leaf.tier}`;
        increment(current.leaves, `${leaf.fn}:${leaf.tier}`);
      } else {
        // Attribution to a generated caller is kept separate from exclusive
        // samples. For example an IC miss may have a generated caller.
        let callerPc = external ? 0 : Number(d);
        let caller = code.get(callerPc);
        if (!caller?.tier) {
          let preceding = pc;
          for (const frame of [f, ...rest]) {
            if (!frame || frame === 'overflow') continue;
            const relative = /^([+-])(?:0x)?([\da-f]+)$/i.exec(frame);
            if (relative) preceding += (relative[1] === '+' ? 1 : -1) * parseInt(relative[2], 16);
            callerPc = relative ? preceding : Number(frame);
            caller = code.get(callerPc);
            if (caller?.tier) break;
          }
        }
        if (caller?.tier) {
          bucket = `under:${caller.fn === 'run' ? 'run' : 'shard'}:${caller.tier}`;
          increment(current.frames, `${caller.fn}:${caller.tier}`);
        }
        increment(current.unclassifiedLeaves, leaf?.rawName || '(native or unresolved)');
        if (
          leaf?.builtin &&
          leaf.rawName.includes('IC') &&
          /Load|Store|Element/.test(leaf.rawName)
        ) {
          const key = caller?.tier ? `${caller.fn}:${caller.tier}` : '(no generated caller)';
          increment(current.icCallers, key);
          if (caller?.tier && caller.fn === 'run') {
            increment(
              current.icDispatchSites,
              dispatchSite(caller, callerPc, scripts) ?? '(unmapped run position)',
            );
          }
        }
      }
      increment(bin, bucket);
    }
  }
  if (current) throw new Error(`Missing clear end marker in ${path}`);
  return windows;
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error('Usage: node summarize-tier-profile.mjs <v8.log> [...]');
  const profiles = [];
  for (const path of paths) {
    const windows = await summarize(path);
    if (windows.length) profiles.push({ path, windows });
  }
  if (!profiles.length) throw new Error('No CT117E clear markers found');
  console.log(JSON.stringify(profiles, null, 2));
}
