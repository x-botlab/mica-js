import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Box,
  Cable,
  Check,
  Layers,
  Play,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  Unplug,
  X,
} from 'lucide-react';
import {
  MM,
  PLANE_H,
  PLANE_W,
  board,
  boardEndOf,
  bundlePaths,
  bundlesOf,
  byId,
  connectorOf,
  connectorSpec,
  deviceEndOf,
  initial,
  judge,
  parts,
  pinName,
  pinOf,
  reference as referenceWires,
  refLabel,
  roleColor,
  sameRef,
  wiresAt,
  type PinRef,
  type Point,
  type Wire,
} from './mount-demo-data';
import { Scene3D, type Selection } from './mount-scene3d';
import './mount-demo.css';

type ViewMode = 'flat' | 'solid';

function MountDemo() {
  const [positions, setPositions] = useState<Record<string, Point>>(() => structuredClone(initial));
  const [wires, setWires] = useState<Wire[]>([]);
  const [pending, setPending] = useState<PinRef | null>(null);
  const [selected, setSelected] = useState<Selection>({ kind: 'part', id: 'j1' });
  const [view, setView] = useState<ViewMode>('solid');
  const [running, setRunning] = useState(false);
  const [showBoard, setShowBoard] = useState(true);
  const [notice, setNotice] = useState('点 J1 的引脚，再点器件引脚即可接线。');
  const [boardOpen, setBoardOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ id: string; at: Point } | null>(null);

  const stage = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origin: Point;
    zoom: number;
  } | null>(null);

  useEffect(() => {
    if (view !== 'flat') return;
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setZoom(
        Math.max(0.4, Math.min(1.3, Math.min((width - 24) / PLANE_W, (height - 24) / PLANE_H))),
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);

  const positionsNow = drag ? { ...positions, [drag.id]: drag.at } : positions;
  const wireAt = (ref: PinRef) => wiresAt(ref, wires)[0];
  const ready = (id: string) => {
    const part = byId(id);
    return (
      part.pins.length > 0 && part.pins.every((pin) => wireAt({ device: part.id, pin: pin.id }))
    );
  };

  function tapPin(ref: PinRef) {
    if (!pending) {
      setPending(ref);
      setSelected({ kind: 'part', id: ref.device });
      setNotice(`已选 ${pinName(ref)}，再点另一端完成接线。再点一次取消。`);
      return;
    }
    if (sameRef(pending, ref)) {
      setPending(null);
      setNotice('已取消选择。');
      return;
    }
    const verdict = judge(pending, ref, wires);
    if (!verdict.ok) {
      setNotice(`${pinName(pending)} ↔ ${pinName(ref)} 未接通：${verdict.reason}`);
      return;
    }
    const firstIsBoard = byId(pending.device).onboard;
    const deviceRef = firstIsBoard ? ref : pending;
    const wire: Wire = {
      a: firstIsBoard ? pending : ref,
      b: firstIsBoard ? ref : pending,
      color: roleColor[pinOf(deviceRef).role],
    };
    setWires((list) => [...list, wire]);
    setPending(null);
    setSelected({ kind: 'wire', index: wires.length });
    setNotice(
      `${pinName(wire.a)} → ${pinName(wire.b)} 已接好${verdict.warn ? ` · ${verdict.warn}` : '，两脚并入同一网络'}。`,
    );
  }

  function applyReference() {
    setWires(structuredClone(referenceWires));
    setPending(null);
    setNotice('已按参考接法补齐电源、地与信号：J1 引出 4 束圆线，J2 插上 8 芯 FPC 排线。');
  }

  function clearWires() {
    setWires([]);
    setPending(null);
    setNotice('已清空全部线束。');
  }

  function removeSelected() {
    if (selected?.kind !== 'wire') return;
    const wire = wires[selected.index];
    if (!wire) return;
    setWires((list) => list.filter((_, index) => index !== selected.index));
    setSelected({ kind: 'part', id: wire.b.device });
    setNotice(`已断开 ${refLabel(wire.a)} → ${refLabel(wire.b)}，对应器件立即失联。`);
  }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>, id: string) {
    if (view !== 'flat' || event.button !== 0) return;
    const surface = stage.current?.querySelector('.plane');
    if (!surface) return;
    dragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      origin: positions[id]!,
      zoom: surface.getBoundingClientRect().width / PLANE_W,
    };
    setSelected({ kind: 'part', id });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best effort */
    }
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = dragRef.current;
    if (!current) return;
    const dx = (event.clientX - current.startX) / current.zoom;
    const dy = (event.clientY - current.startY) / current.zoom;
    if (Math.hypot(dx, dy) < 2) return;
    setDrag({ id: current.id, at: { x: current.origin.x + dx, y: current.origin.y + dy } });
  }

  function pointerUp() {
    const current = dragRef.current;
    dragRef.current = null;
    if (!current || !drag) return;
    const part = byId(current.id);
    const at = drag.at;
    const halfW = (part.w * MM) / 2;
    const halfD = (part.d * MM) / 2;
    const inside =
      at.x - halfW >= board.x &&
      at.x + halfW <= board.x + board.w &&
      at.y - halfD >= board.y &&
      at.y + halfD <= board.y + board.h;
    setDrag(null);
    if (part.onboard && !inside) {
      setNotice(`${part.designator} 是板上器件，必须整个落在 PCB 外形内。已退回。`);
      return;
    }
    if (!part.onboard && inside) {
      setNotice(`${part.designator} 是板外器件，不占板面：放在台面用线束连回 J1。`);
      return;
    }
    setPositions((value) => ({ ...value, [part.id]: at }));
    setNotice(`${part.designator} 已移动到 ${part.onboard ? 'PCB' : '台面'}。`);
  }

  const selectedIndex = selected?.kind === 'wire' ? selected.index : -1;
  const selectedWire = selectedIndex >= 0 ? wires[selectedIndex] : undefined;
  const selectedPart = selected?.kind === 'part' ? byId(selected.id) : undefined;
  const deviceCount = parts.filter((part) => !part.onboard).length;
  const devicePins = parts
    .filter((part) => !part.onboard)
    .reduce((sum, part) => sum + part.pins.length, 0);
  const bundles = bundlesOf(wires, positionsNow);
  const paths = bundlePaths(wires, positionsNow);
  const selectedBundle =
    selectedIndex >= 0
      ? bundles.find((bundle) => bundle.indexes.includes(selectedIndex))
      : undefined;
  const selectWire = (index: number) => setSelected({ kind: 'wire', index });

  return (
    <div className="mount-app">
      <header className="mount-header">
        <a className="mount-brand" href="/">
          <span>m</span> mica <small>实验室</small>
        </a>
        <div className="mount-title">
          板外器件接线 · 端子与线束 <em>three.js 原型</em>
        </div>
        <button className="quiet-button" onClick={clearWires}>
          <RotateCcw size={14} />
          清空线束
        </button>
      </header>

      <div className="mount-body">
        <aside className="mount-sidebar">
          <h2>
            接线 <span>{wires.length} 芯</span>
          </h2>
          <section className="palette">
            <header>
              <b>板端 J1 · 6P 排针</b>
              <small>2.54 mm 间距 · 每脚一个网络，可接多根线</small>
            </header>
            {byId('j1').pins.map((pin) => {
              const ref = { device: 'j1', pin: pin.id };
              const count = wiresAt(ref, wires).length;
              return (
                <button
                  key={pin.id}
                  className={pending && sameRef(pending, ref) ? 'selected' : ''}
                  onClick={() => tapPin(ref)}
                >
                  <i className={`dot dot-${pin.role}`} />
                  <span>
                    {pin.id} · {pin.label}
                    <small>{count} 根</small>
                  </span>
                </button>
              );
            })}
          </section>
          {parts
            .filter((part) => !part.onboard)
            .map((part) => (
              <section key={part.id} className="palette">
                <header>
                  <b>
                    {part.designator} · {part.title}
                  </b>
                  <small>
                    {part.connectors.length} 个接头 · 本体高 {part.h} mm
                  </small>
                </header>
                {part.connectors.map((connector) => (
                  <div key={connector.id} className="connector-group">
                    <span className="connector-chip">
                      {connector.label} · {connectorSpec(connector)}
                    </span>
                    {part.pins
                      .filter((pin) => pin.connector === connector.id)
                      .map((pin) => {
                        const ref = { device: part.id, pin: pin.id };
                        const wire = wireAt(ref);
                        return (
                          <button
                            key={pin.id}
                            className={pending && sameRef(pending, ref) ? 'selected' : ''}
                            onClick={() => tapPin(ref)}
                          >
                            <i className={`dot dot-${pin.role}`} />
                            <span>
                              {pin.label}
                              <small>
                                {wire
                                  ? `→ ${refLabel(sameRef(wire.a, ref) ? wire.b : wire.a)}`
                                  : '未接'}
                              </small>
                            </span>
                          </button>
                        );
                      })}
                  </div>
                ))}
              </section>
            ))}
        </aside>

        <main className="mount-main">
          <div className="mount-toolbar">
            <div className="view-switch">
              <button
                aria-pressed={view === 'flat'}
                className={view === 'flat' ? 'active' : ''}
                onClick={() => setView('flat')}
              >
                <Layers size={14} />
                2D 编辑器
              </button>
              <button
                aria-pressed={view === 'solid'}
                className={view === 'solid' ? 'active' : ''}
                onClick={() => setView('solid')}
              >
                <Box size={14} />
                3D 视图
              </button>
            </div>
            <button className="run-button" onClick={applyReference}>
              <Sparkles size={13} />
              参考接线
            </button>
            <button
              className={`run-button ${running ? 'active' : ''}`}
              onClick={() => setRunning((v) => !v)}
            >
              <Play size={13} />
              {running ? '停止' : '运行'}
            </button>
            <div className="mount-toggles">
              {view === 'flat' && (
                <label>
                  <input
                    type="checkbox"
                    checked={showBoard}
                    onChange={(event) => setShowBoard(event.target.checked)}
                  />
                  显示板
                </label>
              )}
              <span className="counter">
                {wires.length} / {devicePins} 芯
              </span>
            </div>
          </div>

          <div className="mount-stage" ref={stage} data-view={view} data-live={running}>
            {view === 'solid' ? (
              <Scene3D
                positions={positions}
                wires={wires}
                running={running}
                pending={pending}
                selected={selected}
                onPickPin={tapPin}
                onPickWire={selectWire}
                onPickPart={(id) => setSelected({ kind: 'part', id })}
                onOpenBoard={() => {
                  setBoardOpen(true);
                  setNotice('已打开这块板的电路：板内走线仍在原来的 2D 编辑器里编辑。');
                }}
              />
            ) : (
              <div className="plane" style={{ '--zoom': zoom } as CSSProperties}>
                {showBoard && (
                  <div
                    className="board"
                    style={{ left: board.x, top: board.y, width: board.w, height: board.h }}
                  >
                    <span className="board-tag">PCB · 76 × 60 mm</span>
                  </div>
                )}

                <svg className="wire-layer" width={PLANE_W} height={PLANE_H} aria-hidden="true">
                  {paths.map((bundle) => (
                    <g key={bundle.key}>
                      {bundle.form === 'ribbon' ? (
                        <>
                          <path
                            className="ribbon-edge"
                            d={bundle.trunk}
                            strokeWidth={bundle.widthPx + 1.4}
                          />
                          <path
                            className={`ribbon-band ${bundle.tooShort ? 'is-short' : ''}`}
                            d={bundle.trunk}
                            strokeWidth={bundle.widthPx}
                          />
                          {bundle.cores.map((core) => (
                            <path
                              key={core.index}
                              className="ribbon-core"
                              d={core.d}
                              strokeWidth={1.1}
                            />
                          ))}
                          <path
                            className={`ribbon-hit ${
                              bundle.indexes.includes(selectedIndex) ? 'is-active' : ''
                            }`}
                            d={bundle.trunk}
                            strokeWidth={bundle.widthPx + 5}
                            onClick={() => selectWire(bundle.indexes[0]!)}
                          />
                        </>
                      ) : (
                        bundle.cores.map((core) => (
                          <g key={core.index}>
                            <path
                              className={`wire-core ${
                                selectedIndex === core.index ? 'is-active' : ''
                              }`}
                              d={core.d}
                              stroke={core.color}
                            />
                            <path
                              className="wire-hit"
                              d={core.d}
                              onClick={() => selectWire(core.index)}
                            />
                          </g>
                        ))
                      )}
                    </g>
                  ))}
                </svg>

                {parts.map((part) => {
                  const center = positionsNow[part.id]!;
                  const rect = {
                    left: center.x - (part.w * MM) / 2,
                    top: center.y - (part.d * MM) / 2,
                    width: part.w * MM,
                    height: part.d * MM,
                  };
                  const isSelected = selected?.kind === 'part' && selected.id === part.id;
                  return (
                    <div
                      key={part.id}
                      className={`part part-${part.kind} ${part.onboard ? 'is-flat' : 'is-plate'} ${isSelected ? 'is-selected' : ''}`}
                      style={rect}
                      onPointerDown={(event) => pointerDown(event, part.id)}
                      onPointerMove={pointerMove}
                      onPointerUp={pointerUp}
                      onPointerCancel={pointerUp}
                    >
                      {part.onboard ? (
                        <>
                          {part.kind === 'chip' ? (
                            <>
                              <span className="chip-notch" />
                              <span className="chip-mark">89C52</span>
                            </>
                          ) : (
                            <span className="terminal-body" />
                          )}
                          {part.pins.map((pin) => {
                            const ref = { device: part.id, pin: pin.id };
                            return (
                              <button
                                key={pin.id}
                                className={`pin pin-${pin.role} ${wireAt(ref) ? 'is-wired' : ''} ${
                                  pending && sameRef(pending, ref) ? 'is-pending' : ''
                                }`}
                                style={{ left: `calc(50% + ${pin.dx * MM}px)`, top: '50%' }}
                                title={`${refLabel(ref)} · ${pin.label}`}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  tapPin(ref);
                                }}
                              >
                                <span className="pin-name">{pin.id}</span>
                              </button>
                            );
                          })}
                          <span className="part-label">
                            <b>{part.designator}</b>
                            {isSelected && <em>{part.title}</em>}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="part-plate">
                            <b>{part.designator}</b>
                            <em>{part.title}</em>
                          </span>
                          {part.pins.map((pin) => {
                            const ref = { device: part.id, pin: pin.id };
                            return (
                              <button
                                key={pin.id}
                                className={`pin pin-${pin.role} ${wireAt(ref) ? 'is-wired' : ''} ${
                                  pending && sameRef(pending, ref) ? 'is-pending' : ''
                                }`}
                                style={{ left: `calc(50% + ${pin.dx * MM}px)`, bottom: 0 }}
                                title={`${refLabel(ref)} · ${pin.label}`}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  tapPin(ref);
                                }}
                              >
                                <span className="pin-name">{pin.label}</span>
                              </button>
                            );
                          })}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mount-status" role="status">
            <i className={`state state-${pending ? 'warn' : wires.length ? 'ok' : 'idle'}`} />
            {notice}
          </div>
          <footer className="mount-footer">
            <span>
              {wires.length} 芯 / {bundles.length} 束 ·{' '}
              {parts.filter((part) => !part.onboard && ready(part.id)).length} / {deviceCount}{' '}
              个器件接全 · {view === 'solid' ? 'three.js 场景' : '2D 画布'}
            </span>
            <span>端子引脚可一拖多 · 器件引脚只有一根 · 一束线 = 一次接头插合</span>
          </footer>
        </main>

        <aside className="mount-inspector">
          <div className="inspector-heading">
            连线检查器<span>HARNESS</span>
          </div>

          {selectedWire ? (
            <div className="inspector-part">
              <span>WIRE</span>
              <h2>
                {pinName(selectedWire.a)} → {pinName(selectedWire.b)}
              </h2>
              <dl className="facts">
                <div>
                  <dt>板端接头</dt>
                  <dd>
                    {connectorOf(boardEndOf(selectedWire)).label} ·{' '}
                    {connectorOf(boardEndOf(selectedWire)).pitch} mm
                  </dd>
                </div>
                <div>
                  <dt>器件接头</dt>
                  <dd>
                    {connectorOf(deviceEndOf(selectedWire)).label} ·{' '}
                    {connectorOf(deviceEndOf(selectedWire)).pitch} mm
                  </dd>
                </div>
                <div>
                  <dt>线缆形态</dt>
                  <dd>
                    {connectorOf(deviceEndOf(selectedWire)).cable === 'ribbon'
                      ? 'FPC 排线'
                      : '圆线束'}
                  </dd>
                </div>
                <div>
                  <dt>电气含义</dt>
                  <dd>两脚并入同一网络</dd>
                </div>
                {selectedBundle && (
                  <div>
                    <dt>所属线束</dt>
                    <dd>
                      {selectedBundle.indexes.length} 芯 · 跨距 {selectedBundle.spanMm.toFixed(0)}{' '}
                      mm
                    </dd>
                  </div>
                )}
                {selectedBundle?.lengthMm && (
                  <div>
                    <dt>排线余量</dt>
                    <dd className={selectedBundle.tooShort ? 'is-warn' : ''}>
                      {(selectedBundle.lengthMm - selectedBundle.spanMm).toFixed(0)} mm
                      {selectedBundle.tooShort ? '（不够）' : ''}
                    </dd>
                  </div>
                )}
              </dl>
              <button className="danger-button" onClick={removeSelected}>
                <Unplug size={13} />
                断开这根线
              </button>
            </div>
          ) : (
            selectedPart && (
              <div className="inspector-part">
                <span>{selectedPart.onboard ? 'ON BOARD' : 'OFF BOARD'}</span>
                <h2>
                  {selectedPart.designator} · {selectedPart.title}
                </h2>
                <dl className="facts">
                  <div>
                    <dt>外形</dt>
                    <dd>
                      {selectedPart.w} × {selectedPart.d} × {selectedPart.h} mm
                    </dd>
                  </div>
                  <div>
                    <dt>连接</dt>
                    <dd>
                      {selectedPart.onboard
                        ? '焊在板上'
                        : `${selectedPart.connectors.length} 个接头 + 线束`}
                    </dd>
                  </div>
                  {selectedPart.connectors.map((connector) => (
                    <div key={connector.id}>
                      <dt>{connector.label}</dt>
                      <dd>
                        {connector.contacts}P · {connector.pitch} mm ·{' '}
                        {connector.cable === 'ribbon' ? '排线' : '圆线'}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>状态</dt>
                    <dd>
                      {selectedPart.onboard
                        ? '—'
                        : `${selectedPart.pins.filter((pin) => wireAt({ device: selectedPart.id, pin: pin.id })).length} / ${selectedPart.pins.length} 已接`}
                    </dd>
                  </div>
                </dl>
              </div>
            )
          )}

          <section className="inspector-section">
            <h3>
              <Cable size={13} />
              线束 {bundles.length}
            </h3>
            {bundles.length === 0 && <p className="empty">还没有线束</p>}
            {bundles.map((bundle, order) => (
              <div key={bundle.key} className="bundle">
                <header>
                  <b>
                    CX{order + 1} · {bundle.boardConnector.label} ⇄ {bundle.deviceConnector.label}
                  </b>
                  <small>
                    {bundle.form === 'ribbon'
                      ? `FPC ${bundle.lengthMm} mm · ${bundle.indexes.length} 芯`
                      : `圆线 · ${bundle.indexes.length} 芯`}{' '}
                    · 跨距 {bundle.spanMm.toFixed(0)} mm
                  </small>
                </header>
                {bundle.tooShort && (
                  <p className="bundle-warn">
                    线长不足：{bundle.lengthMm} mm 排线跨不到 {bundle.spanMm.toFixed(0)} mm 远的器件
                  </p>
                )}
                {bundle.tooLong && !bundle.tooShort && (
                  <p className="bundle-hint">
                    余量 {(bundle.lengthMm! - bundle.spanMm).toFixed(0)}{' '}
                    mm：排线要盘出服务弯，不能硬拉直
                  </p>
                )}
                <ul className="wire-list">
                  {bundle.indexes.map((index) => {
                    const wire = wires[index]!;
                    return (
                      <li key={`${wire.a.pin}-${wire.b.device}${wire.b.pin}`}>
                        <button
                          className={selectedIndex === index ? 'selected' : ''}
                          onClick={() => selectWire(index)}
                        >
                          <i style={{ background: wire.color }} />
                          {refLabel(wire.a)} → {refLabel(wire.b)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            <p className="inspector-tip">
              一束线对应一次接头插合：板端接头与器件接头之间共用一根主干，两端散成单芯。
            </p>
          </section>

          <section className="inspector-section">
            <h3>
              <TriangleAlert size={13} />
              接线规则
            </h3>
            <ul className="rule-list">
              <li>
                <Check size={11} />
                接头形态必须插得上
              </li>
              <li>
                <Check size={11} />
                排线线序固定，不能跳接
              </li>
              <li>
                <Check size={11} />
                同一接头的芯落在同一板端接头
              </li>
              <li>
                <Check size={11} />
                器件引脚只能接一根
              </li>
              <li>
                <Check size={11} />
                +5V 与 GND 不能短接
              </li>
            </ul>
            <p className="inspector-tip">
              3D 视图里点端子接线，点器件体选中，拖动空白旋转相机，滚轮缩放，双击 PCB 打开电路文档。
            </p>
          </section>
        </aside>
      </div>

      {boardOpen && (
        <div className="board-modal" role="dialog" aria-label="PCB 电路文档">
          <div className="board-modal-bar">
            <span>
              双击 PCB 打开的电路文档 · <b>/fusion-demo.html</b>
            </span>
            <button onClick={() => setBoardOpen(false)}>
              <X size={14} />
              返回装配
            </button>
          </div>
          <iframe title="PCB 电路文档" src="/fusion-demo.html" />
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<MountDemo />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
