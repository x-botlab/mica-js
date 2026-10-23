import { timePs } from '@mica-js/core';
import { createCanvasScene, DARK_CANVAS_THEME, type CanvasScene } from '@mica-js/canvas-editor';
import {
  createPackageWidgetProvider,
  createWidgetHost,
  type PackageFiles,
  type WidgetHost,
} from '@mica-js/widget';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SCENARIOS, scenarioById, type Scenario, type ScenarioId } from '@/sim/scenarios';
import {
  SimulationSession,
  STEP_PS,
  type ReplayResult,
  type SessionSnapshot,
  type DeviceCapability,
} from '@/sim/session';
import { formatTimePs } from '@/sim/trace';

/** The demo widget package already used by the canvas page; its button publishes `press`. */
const WIDGET_FILES: PackageFiles = {
  label: 'demo',
  read: async (path) => {
    const response = await fetch(new URL(`widgets/${path}`, document.baseURI));
    if (!response.ok) {
      throw new Error(`读取 widgets/${path} 失败（HTTP ${response.status}）`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

interface AppDiagnostic {
  readonly code: string;
  readonly message: string;
}

function initialDrafts(scenario: Scenario): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const input of scenario.inputs) {
    if (input.kind === 'bytes') {
      drafts[input.id] = input.presets[0]?.hex ?? '';
    }
  }
  return drafts;
}

/**
 * Interactive bench over `@mica-js/simulator`.
 *
 * The page owns the session and the canvas; the executor owns the clock and the device instances.
 * Every number here is read from the simulation — nothing is re-derived in the UI.
 */
export function SimulatorPage() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('button');
  const [generation, setGeneration] = useState(0);
  const scenario = scenarioById(scenarioId);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | undefined>(undefined);
  const [replay, setReplay] = useState<ReplayResult | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [appDiagnostics, setAppDiagnostics] = useState<readonly AppDiagnostic[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => initialDrafts(scenario));
  const [sandboxed, setSandboxed] = useState(false);
  const sessionRef = useRef<SimulationSession | undefined>(undefined);
  const hostRef = useRef<WidgetHost | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const pushAppDiagnostic = useCallback((code: string, message: string) => {
    setAppDiagnostics((rows) => [...rows, { code, message }].slice(-20));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let scene: CanvasScene | undefined;
    let host: WidgetHost | undefined;
    const session = new SimulationSession(scenario);
    sessionRef.current = session;
    setSnapshot(undefined);
    setReplay(undefined);
    setFailure(undefined);
    setAppDiagnostics([]);
    setDrafts(initialDrafts(scenario));
    setSandboxed(false);
    const unsubscribe = session.subscribe(() => {
      if (!cancelled) {
        setSnapshot(session.getSnapshot());
      }
    });

    const start = async (): Promise<void> => {
      await session.load();
      if (cancelled) {
        return;
      }
      const loaded = session.getSnapshot();
      setSnapshot(loaded);
      if (loaded.phase === 'failed') {
        setFailure(loaded.lastError);
        return;
      }
      const canvas = scenario.canvas;
      const container = stageRef.current;
      const executor = session.executor;
      if (canvas === undefined || container === null || executor === undefined) {
        return;
      }
      try {
        const provider = await createPackageWidgetProvider({ files: WIDGET_FILES });
        const createdHost = createWidgetHost({
          provider,
          simulation: executor,
          onPublish: (publish) => scene?.receivePublish(publish),
          onDiagnostic: (diagnostic) => pushAppDiagnostic(diagnostic.code, diagnostic.message),
        });
        host = createdHost;
        hostRef.current = createdHost;
        const created = await createCanvasScene({
          container,
          document: canvas,
          host: createdHost,
          mode: 'run',
          theme: DARK_CANVAS_THEME,
          onDiagnostic: (diagnostic) => pushAppDiagnostic(diagnostic.code, diagnostic.message),
        });
        scene = created;
        created.onPublish((target, payload, simTime) => {
          session.noteWidgetPublish(`${target.symbol}.${target.port}`, payload, simTime);
        });
        if (cancelled) {
          created.destroy();
          scene = undefined;
          await createdHost.dispose();
          host = undefined;
          hostRef.current = undefined;
          return;
        }
        setSandboxed(true);
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      unsubscribe();
      scene?.destroy();
      scene = undefined;
      const owned = host;
      host = undefined;
      hostRef.current = undefined;
      void owned?.dispose();
      session.dispose();
      if (sessionRef.current === session) {
        sessionRef.current = undefined;
      }
    };
  }, [scenario, generation, pushAppDiagnostic]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    // Same convention as the canvas page: a console handle for poking at the mounted bench.
    Object.assign(globalThis, {
      micaSimulator: {
        press: (down: boolean): void => {
          hostRef.current?.dispatch('5f2c1a3b-4d5e-4f60-8a7b-9c1d2e3f4051', {
            type: down ? 'pointerdown' : 'pointerup',
            x: 20,
            y: 20,
            button: 0,
            buttons: down ? 1 : 0,
          });
        },
        snapshot: (): SessionSnapshot | undefined => sessionRef.current?.getSnapshot(),
      },
    });
  }, []);

  const session = sessionRef.current;
  const running = snapshot?.running === true;
  const state = snapshot?.state ?? 'idle';
  const error = failure ?? snapshot?.lastError;
  const diagnostics: readonly {
    readonly key: string;
    readonly code: string;
    readonly message: string;
  }[] = [
    ...(snapshot?.diagnostics ?? [])
      .slice()
      .reverse()
      .map((row) => ({ key: `session-${row.seq}`, code: row.code, message: row.message })),
    ...appDiagnostics
      .slice()
      .reverse()
      .map((row, index) => ({
        key: `app-${index}-${row.code}`,
        code: row.code,
        message: row.message,
      })),
  ].slice(0, 20);

  const runReplay = (): void => {
    const active = sessionRef.current;
    if (active === undefined) {
      return;
    }
    void active.replay().then(setReplay);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="示例场景">
          {SCENARIOS.map((entry) => (
            <Button
              key={entry.id}
              size="xs"
              variant={entry.id === scenarioId ? 'default' : 'outline'}
              role="tab"
              aria-selected={entry.id === scenarioId}
              data-testid={`scenario-${entry.id}`}
              onClick={() => setScenarioId(entry.id)}
            >
              {entry.title}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="outline"
            data-testid="reload"
            disabled={running || snapshot?.phase === 'loading'}
            onClick={() => setGeneration((value) => value + 1)}
          >
            重新加载
          </Button>
          <Button
            size="xs"
            data-testid="run"
            disabled={state !== 'ready' || running}
            onClick={() => session?.start()}
          >
            启动
          </Button>
          <Button
            size="xs"
            variant="outline"
            data-testid="pause"
            disabled={!running}
            onClick={() => session?.pause()}
          >
            暂停
          </Button>
          <Button
            size="xs"
            variant="outline"
            data-testid="step"
            disabled={state !== 'ready' || running}
            onClick={() => session?.step()}
          >
            单步
          </Button>
          <Button
            size="xs"
            variant="outline"
            data-testid="reset"
            disabled={state !== 'ready' && state !== 'faulted'}
            onClick={() => session?.reset()}
          >
            复位
          </Button>
          <Button
            size="xs"
            variant="outline"
            data-testid="dispose"
            disabled={snapshot?.phase === 'disposed' || snapshot?.phase === 'loading'}
            onClick={() => session?.dispose()}
          >
            销毁
          </Button>
          <Button
            size="xs"
            variant="outline"
            data-testid="replay"
            disabled={snapshot?.phase !== 'ready'}
            onClick={runReplay}
          >
            确定性回放 ×2
          </Button>
        </div>
      </div>

      {error === undefined ? null : (
        <p
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
          data-testid="sim-error"
        >
          {error}
        </p>
      )}

      <div className="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                {scenario.title}
                <Badge variant="muted" className="font-mono" data-testid="scenario-id">
                  {scenario.id}
                </Badge>
              </CardTitle>
              <CardDescription data-testid="scenario-summary">{scenario.summary}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div
                key={`${scenario.id}-${generation}`}
                ref={stageRef}
                data-testid="stage"
                className="bg-muted/20 relative h-[240px] w-full overflow-hidden rounded-lg border sm:h-[260px]"
              />
              {scenario.canvas === undefined ? (
                <p className="text-muted-foreground text-[11px]" data-testid="canvas-note">
                  {scenario.canvasNote ?? '该场景没有 canvas。'}
                </p>
              ) : (
                <p className="text-muted-foreground text-[11px]">
                  {sandboxed
                    ? 'widget 运行在 @mica-js/sandbox 的不透明源 iframe 内：点击画布上的按钮，发布经 WidgetHost 进入执行器。'
                    : '正在启动 widget sandbox…'}
                </p>
              )}
              {scenario.inputs.map((input) =>
                input.kind === 'press' ? (
                  <div
                    key={input.id}
                    className="flex flex-col gap-1"
                    data-testid={`control-${input.id}`}
                  >
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        data-testid="press-down"
                        onClick={() => session?.pressInput(input.id, true)}
                      >
                        按下（直接投递）
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        data-testid="press-up"
                        onClick={() => session?.pressInput(input.id, false)}
                      >
                        松开（直接投递）
                      </Button>
                    </div>
                    <p className="text-muted-foreground text-[11px]">
                      这两个按钮绕过画布，仅用于键盘操作；画布路径才经过 sandbox。
                    </p>
                  </div>
                ) : (
                  <div
                    key={input.id}
                    className="flex flex-col gap-1.5"
                    data-testid={`control-${input.id}`}
                  >
                    <div className="flex flex-wrap gap-1">
                      {input.presets.map((preset, index) => (
                        <Button
                          key={preset.label}
                          size="xs"
                          variant="ghost"
                          data-testid={`preset-${index}`}
                          onClick={() =>
                            setDrafts((current) => ({ ...current, [input.id]: preset.hex }))
                          }
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                    <Textarea
                      value={drafts[input.id] ?? ''}
                      spellCheck={false}
                      aria-label={input.title}
                      data-testid="hex-input"
                      className="min-h-[52px] font-mono text-xs"
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [input.id]: event.target.value }))
                      }
                    />
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="xs"
                        data-testid="send-bytes"
                        onClick={() => session?.sendHex(input.id, drafts[input.id] ?? '')}
                      >
                        发送补丁
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        data-testid="send-invalid"
                        onClick={() => session?.sendUnsupportedPayload(input.id)}
                      >
                        发送非法载荷（应被拒绝）
                      </Button>
                    </div>
                    <p className="text-muted-foreground text-[11px]">{input.description}</p>
                  </div>
                ),
              )}
            </CardContent>
          </Card>

          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle>模型能力与限制</CardTitle>
              <CardDescription>
                复位能力由示例模型自己的 reset 声明决定；执行器复位只是按原理图重建实例。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {(snapshot?.capabilities ?? []).map((capability) => (
                <CapabilityRow key={capability.symbol} capability={capability} />
              ))}
              {snapshot !== undefined && snapshot.capabilities.length === 0 ? (
                <p className="text-muted-foreground text-xs">正在读取器件描述…</p>
              ) : null}
              <details className="rounded-md border px-2 py-1.5 text-xs" data-testid="limitations">
                <summary className="cursor-pointer">模型限制（不会被模拟器补成“已完成”）</summary>
                <ul className="text-muted-foreground mt-1.5 flex list-disc flex-col gap-1 pl-4">
                  {scenario.limitations.map((limit) => (
                    <li key={limit}>{limit}</li>
                  ))}
                </ul>
              </details>
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                状态
                <Badge
                  variant="muted"
                  className="font-mono"
                  data-testid="sim-state"
                  data-state={state}
                >
                  {state} · {snapshot?.phase ?? 'idle'}
                </Badge>
              </CardTitle>
              <CardDescription>虚拟时间只由 advance 推动；每步 {STEP_PS} ps。</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">虚拟时间</dt>
                <dd data-testid="sim-time" data-ps={String(snapshot?.simTime ?? 0)}>
                  {formatTimePs(snapshot?.simTime ?? timePs(0))}
                </dd>
                <dt className="text-muted-foreground">步数</dt>
                <dd data-testid="step-count" data-steps={String(snapshot?.steps ?? 0)}>
                  {snapshot?.steps ?? 0} 步
                </dd>
                <dt className="text-muted-foreground">运行循环</dt>
                <dd>{running ? '运行中' : '已暂停'}</dd>
                <dt className="text-muted-foreground">最近推进</dt>
                <dd className="break-words">
                  {snapshot?.lastReport === undefined
                    ? '尚未推进'
                    : `第 ${snapshot.lastReport.step} 步：${snapshot.lastReport.from} → ${snapshot.lastReport.to} ps · 执行 ${snapshot.lastReport.executed} 条 · ${snapshot.lastReport.reason}`}
                </dd>
                <dt className="text-muted-foreground">话题端口</dt>
                <dd className="break-words" data-testid="topics">
                  {snapshot === undefined || snapshot.topics.length === 0
                    ? '无话题端口（该模型只暴露引脚或连接）'
                    : snapshot.topics.join('、')}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle>电气观测（宿主直读）</CardTitle>
              <CardDescription>
                执行器不拥有电路：这些值来自本页创建的 PowerRuntime /
                TopologyRuntime，不是器件发布。
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-[11px]" data-testid="probes">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium">观测点</th>
                    <th className="text-left font-medium">值</th>
                    <th className="text-left font-medium">来源</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.probes ?? []).map((probe) => (
                    <tr key={probe.id} className="border-t">
                      <td className="py-1 pr-2">{probe.title}</td>
                      <td
                        className="py-1 pr-2 font-mono"
                        data-testid={`probe-${probe.id}`}
                        data-value={probe.value}
                      >
                        {probe.value}
                      </td>
                      <td className="text-muted-foreground py-1">
                        {probe.ready ? '宿主直读' : '未就绪（电源域或网络不可用）'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                事件轨迹
                <Badge variant="muted">{snapshot?.trace.length ?? 0}</Badge>
              </CardTitle>
              <CardDescription>
                按虚拟时间倒序；器件发布、电气观测、输入与系统事件同表。
              </CardDescription>
            </CardHeader>
            <CardContent className="max-h-64 overflow-auto">
              <table className="w-full text-[11px]" data-testid="trace">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium">虚拟时间</th>
                    <th className="text-left font-medium">来源</th>
                    <th className="text-left font-medium">内容</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(snapshot?.trace ?? [])].reverse().map((entry) => (
                    <tr
                      key={entry.seq}
                      className="border-t"
                      data-testid="trace-row"
                      data-kind={entry.kind}
                      data-sim-time={String(entry.simTime)}
                    >
                      <td className="py-1 pr-2 font-mono whitespace-nowrap">
                        {formatTimePs(entry.simTime)}
                      </td>
                      <td className="py-1 pr-2">{traceKindLabel(entry.kind)}</td>
                      <td className="py-1 break-words">
                        <span className="font-medium">{entry.label}</span>{' '}
                        <span className="text-muted-foreground">{entry.detail}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snapshot !== undefined && snapshot.trace.length === 0 ? (
                <p className="text-muted-foreground text-xs">还没有事件。</p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="gap-2 py-3">
            <CardHeader>
              <CardTitle>诊断与回放</CardTitle>
              <CardDescription>
                器件层拒绝输入时执行器仍是 ready；只有调度器故障才会暂停并禁用推进。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <ul className="flex flex-col gap-1 text-[11px]" data-testid="diagnostics">
                {diagnostics.length === 0 ? (
                  <li className="text-muted-foreground">没有诊断。</li>
                ) : (
                  diagnostics.map((row) => (
                    <li
                      key={row.key}
                      className="rounded-md border px-2 py-1"
                      data-testid="diagnostic-row"
                      data-code={row.code}
                    >
                      <code className="text-muted-foreground">{row.code}</code>{' '}
                      <span>{row.message}</span>
                    </li>
                  ))
                )}
              </ul>
              {replay === undefined ? null : (
                <p
                  className={cn(
                    'rounded-md border px-2 py-1.5 text-[11px]',
                    replay.equal
                      ? 'border-emerald-600/40 bg-emerald-500/10 text-emerald-400'
                      : 'border-destructive/40 bg-destructive/10 text-destructive',
                  )}
                  data-testid="replay-result"
                  data-equal={String(replay.equal)}
                >
                  {replay.equal
                    ? `确定性回放一致：${replay.steps} 步 / ${replay.entries} 条轨迹 · 摘要 ${replay.digests.join(' = ')}`
                    : `确定性回放不一致：${replay.digests.join(' ≠ ')}`}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CapabilityRow({ capability }: { readonly capability: DeviceCapability }) {
  const tone =
    capability.reset === 'supported'
      ? 'default'
      : capability.reset === 'unsupported'
        ? 'outline'
        : 'muted';
  const label =
    capability.reset === 'supported'
      ? 'reset 支持'
      : capability.reset === 'unsupported'
        ? 'reset 不支持'
        : 'reset 未知';
  return (
    <div
      className="bg-muted/20 flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs"
      data-testid={`capability-${capability.label}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="font-medium">
          {capability.label} · {capability.displayName}
        </span>
        <Badge variant={tone}>{label}</Badge>
      </div>
      <span className="text-muted-foreground font-mono text-[10px]">{capability.deviceId}</span>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 text-[11px]">
        <dt className="text-muted-foreground">引脚</dt>
        <dd className="break-words">{capability.pins.join('、') || '无'}</dd>
        <dt className="text-muted-foreground">连接</dt>
        <dd className="break-words">{capability.connections.join('、') || '无'}</dd>
        <dt className="text-muted-foreground">端口</dt>
        <dd className="break-words">
          {capability.ports.length === 0
            ? '无话题端口'
            : capability.ports
                .map((port) => `${port.key}（${port.direction} · ${port.type}）`)
                .join('、')}
        </dd>
        <dt className="text-muted-foreground">器件 reset</dt>
        <dd
          className="break-words"
          data-testid={`reset-${capability.label}`}
          data-reset={capability.reset}
        >
          {capability.resetDetail}
        </dd>
      </dl>
    </div>
  );
}

function traceKindLabel(kind: string): string {
  switch (kind) {
    case 'publish':
      return '器件发布';
    case 'electrical':
      return '电气观测';
    case 'input':
      return '输入';
    case 'error':
      return '错误';
    default:
      return '系统';
  }
}
