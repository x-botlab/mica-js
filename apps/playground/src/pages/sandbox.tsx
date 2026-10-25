import {
  SandboxError,
  createSandbox,
  type SandboxContract,
  type SandboxHandle,
} from '@mica-js/sandbox';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';

interface GuestApi extends SandboxContract {
  add(a: number, b: number): number;
  computePi(iterations: number): Promise<{ value: number; ms: number; origin: string }>;
  env(): Record<string, string>;
}

const GUEST_CODE = `export function setup(ctx) {
  return {
    add(a, b) {
      return a + b;
    },
    async computePi(iterations) {
      const started = performance.now();
      let sum = 0;
      let sign = 1;
      let divisor = 1;
      for (let i = 0; i < iterations; i += 1) {
        sum += sign / divisor;
        sign = -sign;
        divisor += 2;
      }
      return { value: sum * 4, ms: Math.round((performance.now() - started) * 100) / 100, origin: self.origin };
    },
    env() {
      return {
        origin: String(self.origin),
        document: typeof document,
        localStorage: typeof localStorage,
      };
    },
  };
}
`;

interface LogLine {
  readonly id: number;
  readonly level: string;
  readonly text: string;
}

export function SandboxPage() {
  const sandboxRef = useRef<SandboxHandle<GuestApi> | null>(null);
  const bootId = useRef(0);
  const [code, setCode] = useState(GUEST_CODE);
  const [log, setLog] = useState<readonly LogLine[]>([]);
  const [status, setStatus] = useState('启动中…');
  const [busy, setBusy] = useState(false);

  const pushLog = useCallback((level: string, text: string) => {
    setLog((lines) => [{ id: Date.now() + Math.random(), level, text }, ...lines].slice(0, 60));
  }, []);

  /** Boots one sandbox from `source`; a newer boot supersedes an older one still starting up. */
  const boot = useCallback(
    async (source: string): Promise<void> => {
      const id = bootId.current + 1;
      bootId.current = id;
      setBusy(true);
      setStatus('启动中…');
      const previous = sandboxRef.current;
      sandboxRef.current = null;
      if (previous !== null) {
        await previous.terminate('restart');
        pushLog('lifecycle', 'terminate(restart)');
      }
      try {
        const sandbox = await createSandbox<GuestApi>({
          source: { type: 'module', code: source },
          callTimeoutMs: 2000,
          onLog: (entry) => pushLog(entry.level, entry.parts.map((part) => String(part)).join(' ')),
        });
        if (bootId.current !== id) {
          await sandbox.terminate('superseded');
          return;
        }
        sandboxRef.current = sandbox;
        setStatus(`运行中 · ${sandbox.id}`);
        pushLog(
          'lifecycle',
          `booted · origin=${sandbox.info.origin} · methods=${sandbox.info.guestMethods.join(', ')}`,
        );

        const sum = await sandbox.call('add', 2, 3);
        pushLog('call', `add(2, 3) → ${sum}`);
        const pi = await sandbox.call('computePi', 200000);
        pushLog('call', `computePi(200000) → ${pi.value.toFixed(6)} in ${pi.ms}ms`);
        const env = await sandbox.call('env');
        pushLog('call', `env() → ${JSON.stringify(env)}`);
      } catch (error) {
        const message =
          error instanceof SandboxError ? `${error.code}: ${error.message}` : String(error);
        setStatus('失败');
        pushLog('error', message);
      } finally {
        if (bootId.current === id) {
          setBusy(false);
        }
      }
    },
    [pushLog],
  );

  // No setup step: the page boots the guest as soon as it mounts.
  useEffect(() => {
    void boot(GUEST_CODE);
    return () => {
      bootId.current += 1;
      void sandboxRef.current?.terminate('page unmounted');
      sandboxRef.current = null;
    };
  }, [boot]);

  const stop = async (): Promise<void> => {
    bootId.current += 1;
    const sandbox = sandboxRef.current;
    sandboxRef.current = null;
    if (sandbox !== null) {
      await sandbox.terminate('user');
      pushLog('lifecycle', 'terminate(user)');
    }
    setBusy(false);
    setStatus('已终止');
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] grid-rows-[minmax(0,1fr)] gap-3 p-3">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Button size="xs" onClick={() => void boot(code)} disabled={busy}>
            重新运行
          </Button>
          <Button size="xs" variant="outline" onClick={() => void stop()} disabled={busy}>
            终止
          </Button>
          <Badge variant="muted" className="ml-auto font-mono">
            {status}
          </Badge>
        </div>
        <Textarea
          value={code}
          spellCheck={false}
          onChange={(event) => setCode(event.target.value)}
          className="min-h-0 flex-1 resize-none"
        />
        <p className="text-muted-foreground text-[11px]">
          guest 跑在 opaque-origin Worker 里：没有 DOM、存储与网络，宿主函数只经 capabilities
          暴露。页面加载即启动，改完代码点「重新运行」。
        </p>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <Card className="min-h-0 flex-1 gap-2 py-3">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              日志
              <Badge variant="muted">{log.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto font-mono text-[10.5px]">
            {log.length === 0 ? (
              <span className="text-muted-foreground">等待启动…</span>
            ) : (
              log.map((line) => (
                <div key={line.id} className="flex gap-2">
                  <span className="text-muted-foreground/70 w-14 shrink-0">{line.level}</span>
                  <span className="break-all">{line.text}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
