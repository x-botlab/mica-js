import {
  SandboxError,
  createSandbox,
  type SandboxContract,
  type SandboxHandle,
} from '@mica-js/sandbox';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  const [code, setCode] = useState(GUEST_CODE);
  const [log, setLog] = useState<readonly LogLine[]>([]);
  const [status, setStatus] = useState('未启动');
  const [busy, setBusy] = useState(false);

  const pushLog = (level: string, text: string): void => {
    setLog((lines) => [{ id: Date.now() + Math.random(), level, text }, ...lines].slice(0, 60));
  };

  const stop = async (reason: string): Promise<void> => {
    const sandbox = sandboxRef.current;
    sandboxRef.current = null;
    if (sandbox !== null) {
      await sandbox.terminate(reason);
      pushLog('lifecycle', `terminate(${reason})`);
    }
    setStatus('已终止');
  };

  useEffect(
    () => () => {
      void sandboxRef.current?.terminate('page unmounted');
      sandboxRef.current = null;
    },
    [],
  );

  const run = async (): Promise<void> => {
    setBusy(true);
    await stop('restart');
    try {
      const sandbox = await createSandbox<GuestApi>({
        source: { type: 'module', code },
        callTimeoutMs: 2000,
        onLog: (entry) => pushLog(entry.level, entry.parts.map((part) => String(part)).join(' ')),
      });
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
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] grid-rows-[minmax(0,1fr)] gap-3 p-3">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Button size="xs" onClick={() => void run()} disabled={busy}>
            启动并调用
          </Button>
          <Button size="xs" variant="outline" onClick={() => void stop('user')} disabled={busy}>
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
          客户代码运行在 sandbox="allow-scripts" 的 iframe（不透明源）里的 classic Worker：无
          DOM、无存储、无网络， 宿主只通过 capabilities 暴露函数；`add` / `computePi` / `env` 由
          setup() 返回后经 `sandbox.call()` 调用。
        </p>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <Card className="min-h-0 flex-1 gap-2 py-3">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              事件与控制台输出
              <Badge variant="muted">{log.length}</Badge>
            </CardTitle>
            <CardDescription>onLog 回传的 guest 日志与宿主调用记录</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto font-mono text-[10.5px]">
            {log.length === 0 ? (
              <span className="text-muted-foreground">点「启动并调用」看看发生了什么…</span>
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
