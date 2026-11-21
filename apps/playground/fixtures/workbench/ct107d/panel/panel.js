// ../../node_modules/.pnpm/@mica-js+core@0.7.0/node_modules/@mica-js/core/dist/lifecycle/index.js
var e = class {
	#e = /* @__PURE__ */ new Set();
	#t = !1;
	add(e) {
		if (e === this) throw TypeError("A DisposableStore cannot contain itself");
		return this.#t ? e.dispose() : this.#e.add(e), e;
	}
	clear() {
		let e = [...this.#e];
		this.#e.clear();
		let t = [];
		for (let n of e) try {
			n.dispose();
		} catch (e) {
			t.push(e);
		}
		if (t.length) throw AggregateError(t, "Failed to dispose resources");
	}
	dispose() {
		this.#t || (this.#t = !0, this.clear());
	}
};
function t(e, t) {
	if (!Number.isFinite(t.min) || !Number.isFinite(t.max) || t.min > t.max) throw RangeError(`${t.label} has invalid bounds`);
	let n = e.trim();
	if (n.length === 0) return {
		ok: !1,
		message: `请输入${t.label}`
	};
	let r = Number(n);
	return Number.isFinite(r) ? t.integer === !0 && !Number.isInteger(r) ? {
		ok: !1,
		message: `${t.label}必须是整数`
	} : r < t.min || r > t.max ? {
		ok: !1,
		message: `${t.label}需在 ${v(t.min)}..${v(t.max)} 之间`
	} : {
		ok: !0,
		value: Object.is(r, -0) ? 0 : r
	} : {
		ok: !1,
		message: `${t.label}必须是有限数值`
	};
}
function n(e) {
	if (e.length === 0) return {
		ok: !1,
		message: "请输入要发送的文本"
	};
	let t = g.encode(e);
	return t.length > 64 ? {
		ok: !1,
		message: `UTF-8 编码后 ${t.length} 字节，超过单次 64 字节上限`
	} : {
		ok: !0,
		bytes: t
	};
}
function r(e) {
	if (e.trim().length === 0) return {
		ok: !1,
		message: "请输入十六进制字节"
	};
	if (/0x/i.test(e)) return {
		ok: !1,
		message: "不支持 0x 前缀；请直接写两位十六进制，例如 48 65 6C"
	};
	let t = e.replace(/\s+/g, "");
	for (let e = 0; e < t.length; e += 1) {
		let n = t[e];
		if (n !== void 0 && !_.test(n)) return {
			ok: !1,
			message: `第 ${e + 1} 个十六进制字符 ${JSON.stringify(n)} 无效；仅接受 0-9、A-F 和空白分隔`
		};
	}
	if (t.length % 2 != 0) return {
		ok: !1,
		message: `十六进制内容有 ${t.length} 位；每个字节需要两位，不能为奇数`
	};
	let n = t.length / 2;
	if (n > 64) return {
		ok: !1,
		message: `解析后 ${n} 字节，超过单次 64 字节上限`
	};
	let r = new Uint8Array(n);
	for (let e = 0; e < n; e += 1) r[e] = Number.parseInt(t.slice(e * 2, e * 2 + 2), 16);
	return {
		ok: !0,
		bytes: r
	};
}
function i(e, t) {
	let n = t === void 0 ? e.length : Math.max(0, Math.min(t, e.length)), r = [];
	for (let t = 0; t < n; t += 1) {
		let n = e[t];
		n !== void 0 && r.push(n.toString(16).padStart(2, "0").toUpperCase());
	}
	return r.length === 0 ? "" : `${r.join(" ")}${e.length > n ? " …" : ""}`;
}
function a(e) {
	let t = "";
	for (let n of e) t += n >= 32 && n <= 126 ? String.fromCharCode(n) : "·";
	return t;
}
function o(e, t = 8, n = 0) {
	if (!Number.isSafeInteger(t) || t <= 0) throw RangeError("bytesPerRow must be a positive safe integer");
	if (!Number.isSafeInteger(n) || n < 0) throw RangeError("startAddress must be a nonnegative safe integer");
	let r = [], o = e.length === 0 ? 4 : Math.max(4, (n + e.length - 1).toString(16).length);
	for (let s = 0; s < e.length; s += t) {
		let c = n + s, l = e.subarray(s, s + t);
		r.push({
			address: c,
			offset: c.toString(16).padStart(o, "0").toUpperCase(),
			hex: i(l),
			ascii: a(l)
		});
	}
	return r;
}
var s = class {
	capacity;
	#e = 0;
	#t = 0;
	#n = 0;
	constructor(e) {
		if (!Number.isSafeInteger(e) || e <= 0) throw RangeError("Serial capacity must be a positive safe integer");
		this.capacity = e;
	}
	get nextCursor() {
		return this.#e;
	}
	get droppedBytes() {
		return this.#t;
	}
	get gapBytes() {
		return this.#n;
	}
	ingest(e) {
		let { start: t, data: n } = e;
		if (!Number.isSafeInteger(t) || t < 0) throw RangeError("Serial chunk start must be a nonnegative safe integer");
		if (!(n instanceof Uint8Array)) throw TypeError("Serial chunk data must be a Uint8Array");
		let r = e.dropped ?? 0;
		if (!Number.isSafeInteger(r) || r < 0) throw RangeError("Serial dropped count must be a nonnegative safe integer");
		let i = t + n.length;
		if (!Number.isSafeInteger(i)) throw RangeError("Serial chunk end must be a safe integer");
		if (i <= this.#e) return {
			start: t,
			end: i,
			appended: /* @__PURE__ */ new Uint8Array(),
			duplicateBytes: n.length,
			gapBytes: 0,
			droppedBytes: 0
		};
		let a = Math.max(0, this.#e - t), o = Math.max(0, t - this.#e), s = Math.max(0, o - r);
		this.#t += r, this.#n += s;
		let c = n.slice(a);
		return this.#e = i, {
			start: t,
			end: i,
			appended: c,
			duplicateBytes: a,
			gapBytes: s,
			droppedBytes: r
		};
	}
}, c = class {
	#e = /* @__PURE__ */ new Map();
	bump(e) {
		this.#e.set(e, (this.#e.get(e) ?? 0) + 1);
	}
	snapshot() {
		return new Map(this.#e);
	}
	isUnchanged(e, t) {
		return (this.#e.get(e) ?? 0) === (t.get(e) ?? 0);
	}
};
function l(e, t, n, r, i) {
	return e.isUnchanged(n, t) ? i : r;
}
var u = class {
	#e = 0;
	start() {
		return this.#e += 1, this.#e;
	}
	isCurrent(e) {
		return e === this.#e;
	}
	invalidate() {
		this.#e += 1;
	}
}, d = class {
	disposables = new e();
	#e = !1;
	get closed() {
		return this.#e;
	}
	track(e) {
		this.disposables.add(e);
	}
	close() {
		this.#e || (this.#e = !0, this.disposables.dispose());
	}
};
function f(e) {
	if (e instanceof Error) return e.message;
	if (typeof e == "string") return e;
	try {
		return JSON.stringify(e);
	} catch {
		return String(e);
	}
}
async function p(e) {
	try {
		return {
			ok: !0,
			value: await e()
		};
	} catch (e) {
		return {
			ok: !1,
			message: f(e)
		};
	}
}
function m(e) {
	if (e === void 0) return "此器件未声明运行模型；控制与串口不可用。";
	if (e.methods === void 0) return "模型接口缺少 methods；控制与串口不可用。";
}
function h(e) {
	return e === void 0 || !Number.isFinite(e) || e < 0 ? "历史" : `+${(e / 0xe8d4a51000).toFixed(3)} s`;
}
var g = new TextEncoder(), _ = /^[0-9a-f]$/i;
function v(e) {
	return String(Number.isInteger(e) ? e : Number(e.toFixed(6)));
}
var y = [
	"J13",
	"J3",
	"J2",
	"J5",
	"J2Tx",
	"J6"
];
function b(e) {
	return e === "J2Tx" ? {
		designator: "J2",
		port: "closedState1"
	} : {
		designator: e,
		port: e === "J2" ? "closedState2" : "closedState"
	};
}
function x(e, t) {
	if (t.startsWith("closedState")) return y.find((n) => {
		let r = b(n);
		return r.designator === e && r.port === t;
	});
}
function S(e, t) {
	return e === "J2Tx" ? {
		designator: "J2",
		channel: 1,
		closed: t
	} : {
		designator: e,
		closed: t
	};
}
// src/panel/panel.ts
var C = [
	"S1",
	"S4",
	"S5",
	"S6",
	"S7",
	"S8",
	"S9",
	"S10",
	"S11",
	"S12",
	"S13",
	"S14",
	"S15",
	"S16",
	"S17",
	"S18",
	"S19"
], w = y, T = [
	"LD1",
	"U11",
	"U20"
];
function E(e) {
	return C.includes(e);
}
function D(e, t, n, r, i) {
	let a = { ...r };
	for (let r of Object.keys(i)) e.isUnchanged(`${n}.${String(r)}`, t) && (a[r] = i[r]);
	return a;
}
function O(e, t, n, r) {
	let i = t.pcf8591.analog.map((t, i) => r.isUnchanged(`pcf8591.analog.${i}`, n) ? t : e.pcf8591.analog[i] ?? t);
	return {
		...e,
		latches: D(r, n, "latches", e.latches, t.latches),
		relay: l(r, n, "relay", e.relay, t.relay),
		buzzer: l(r, n, "buzzer", e.buzzer, t.buzzer),
		hall: l(r, n, "hall", e.hall, t.hall),
		amplifier: D(r, n, "amplifier", e.amplifier, t.amplifier),
		temperature: D(r, n, "temperature", e.temperature, t.temperature),
		lm386: D(r, n, "lm386", e.lm386, t.lm386),
		switches: D(r, n, "switches", e.switches, t.switches),
		jumpers: D(r, n, "jumpers", e.jumpers, t.jumpers),
		infrared: D(r, n, "infrared", e.infrared, t.infrared),
		decoder: D(r, n, "decoder", e.decoder, t.decoder),
		uln2003: D(r, n, "uln2003", e.uln2003, t.uln2003),
		pcf8591: {
			...D(r, n, "pcf8591", e.pcf8591, t.pcf8591),
			analog: i
		},
		displays: t.displays,
		leds: t.leds,
		ledStates: t.ledStates,
		ne555: t.ne555
	};
}
var k = class {
	#e;
	#t = new c();
	#n = [];
	#r = !1;
	get readback() {
		return this.#e;
	}
	get closed() {
		return this.#r;
	}
	close() {
		this.#r = !0, this.#n.length = 0;
	}
	beginSnapshot() {
		return this.#t.snapshot();
	}
	applySnapshot(e, t) {
		if (this.#r) return !1;
		if (this.#e === void 0) {
			this.#e = e;
			let t = this.#n.splice(0);
			for (let e of t) this.#a(e);
			return !0;
		}
		return this.#e = O(this.#e, e, t, this.#t), !0;
	}
	applySignal(e) {
		return this.#i({
			kind: "signal",
			value: e
		});
	}
	applyBytes(e) {
		return this.#i({
			kind: "bytes",
			value: e
		});
	}
	applyAmplifier(e) {
		return this.#i({
			kind: "amplifier",
			value: e
		});
	}
	applyLocal(e, t) {
		return this.#i({
			kind: "mutation",
			fields: e,
			update: t
		});
	}
	setSwitch(e, t) {
		return this.applyLocal([`switches.${e}`], (n) => {
			let r = { ...n.switches };
			return r[e] = t, {
				...n,
				switches: r
			};
		});
	}
	setJumper(e, t) {
		return this.applyLocal([`jumpers.${e}`], (n) => {
			let r = { ...n.jumpers };
			return r[e] = t, {
				...n,
				jumpers: r
			};
		});
	}
	setIr(e, t) {
		return this.applyLocal([`infrared.${e}`], (n) => {
			let r = { ...n.infrared };
			return r[e] = t, {
				...n,
				infrared: r
			};
		});
	}
	setAnalog(e, t) {
		return this.applyLocal([`pcf8591.analog.${e}`], (n) => {
			let r = [...n.pcf8591.analog];
			return r[e] = t, {
				...n,
				pcf8591: {
					...n.pcf8591,
					analog: r
				}
			};
		});
	}
	#i(e) {
		return this.#r ? !1 : this.#e === void 0 ? (this.#n.push(e), !0) : (this.#a(e), !0);
	}
	#a(e) {
		e.kind === "signal" ? this.#s(e.value) : e.kind === "bytes" ? this.#c(e.value) : e.kind === "amplifier" ? this.#o([
			"amplifier.position",
			"amplifier.gain",
			"amplifier.outputVoltage"
		], (t) => ({
			...t,
			amplifier: e.value
		})) : this.#o(e.fields, e.update);
	}
	#o(e, t) {
		if (this.#e !== void 0) {
			this.#e = t(this.#e);
			for (let t of e) this.#t.bump(t);
		}
	}
	#s(e) {
		let { designator: t, port: n, value: r } = e;
		if (t === "U6" && n === "latch") this.#l("U6", r);
		else if (t === "U7" && n === "latch") this.#l("U7", r);
		else if (t === "U8" && n === "latch") this.#l("U8", r);
		else if (t === "U9" && n === "latch") this.#l("U9", r);
		else if (t === "K1" && n === "energized") this.#o(["relay"], (e) => ({
			...e,
			relay: r !== 0
		}));
		else if (t === "SP1" && n === "active") this.#o(["buzzer"], (e) => ({
			...e,
			buzzer: r !== 0
		}));
		else if (t === "U21" && n === "active") this.#o(["hall"], (e) => ({
			...e,
			hall: r !== 0
		}));
		else if (t === "RB2" && n === "position") this.setAnalog(3, r);
		else if (t === "U14" && n === "active") this.#o(["lm386.active"], (e) => ({
			...e,
			lm386: { active: r !== 0 }
		}));
		else if (t === "U24" && n === "select") this.#o(["decoder.select"], (e) => ({
			...e,
			decoder: {
				...e.decoder,
				select: r
			}
		}));
		else if (t === "U24" && n === "enabled") this.#o(["decoder.enabled"], (e) => ({
			...e,
			decoder: {
				...e.decoder,
				enabled: r !== 0
			}
		}));
		else if (t === "U10" && n === "mask") this.#o(["uln2003.mask"], (e) => ({
			...e,
			uln2003: {
				...e.uln2003,
				mask: r
			}
		}));
		else if (t === "U5" && n === "temperatureOut") this.#o(["temperature.converted", "temperature.value"], (e) => ({
			...e,
			temperature: {
				converted: !0,
				value: r
			}
		}));
		else if (t === "LD1" && n === "carrier") this.setIr("LD1", r !== 0);
		else if (t === "U11" && n === "receiving") this.setIr("U11", r !== 0);
		else if (t === "U20" && n === "receiving") this.setIr("U20", r !== 0);
		else if (E(t) && (n === "pressed" || n === "press")) this.setSwitch(t, r !== 0);
		else {
			let e = x(t, n);
			e !== void 0 && this.setJumper(e, r !== 0);
		}
	}
	#c(e) {
		let { designator: t, port: n, data: r } = e;
		t === "U24" && n === "code" ? this.#o(["decoder.code"], (e) => ({
			...e,
			decoder: {
				...e.decoder,
				code: new TextDecoder().decode(r)
			}
		})) : t === "U10" && n === "channels" && this.#o(["uln2003.channels"], (e) => ({
			...e,
			uln2003: {
				...e.uln2003,
				channels: new TextDecoder().decode(r)
			}
		}));
	}
	#l(e, t) {
		this.#o([`latches.${e}`], (n) => {
			let r = { ...n.latches };
			return r[e] = t, {
				...n,
				latches: r
			};
		});
	}
};
function A(e, t) {
	let n = document.createElement(e);
	return t !== void 0 && (n.className = t), n;
}
function j(e) {
	let t = document.getElementById(e);
	if (t === null) throw Error(`HTML 视图缺少 #${e}`);
	return t;
}
function M(e, t, n) {
	let r = A("section", "group"), i = A("div", "group-head"), a = A("h2", "group-title");
	if (a.textContent = t, i.append(a), n !== void 0) {
		let e = A("span", "group-meta");
		e.textContent = n, i.append(e);
	}
	let o = A("div", "group-body");
	return r.append(i, o), e.append(r), o;
}
function N(e, t) {
	let n = A("p", "readback"), r = A("span", "readback-label");
	r.textContent = t;
	let i = A("span", "readback-value");
	return i.textContent = "—", n.append(r, i), e.append(n), i;
}
function P(e, t) {
	let n = A("p", "subhead");
	n.textContent = t, e.append(n);
}
function F(e, t) {
	return e === void 0 ? "—" : e.toFixed(t);
}
function I(e, t) {
	return e.toFixed(t).replace(/\.?0+$/, "");
}
function L(e) {
	return e === void 0 ? "—" : `0x${e.toString(16).padStart(2, "0").toUpperCase()}`;
}
function R(e) {
	return e === void 0 ? "—" : `${I(e / 1e6, 4)} MHz`;
}
function z() {
	return (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: !1 });
}
function B(e, n) {
	let r = A("div", "control"), i = A("div", "control-head"), a = A("label", "control-label");
	a.htmlFor = n.id, a.textContent = n.label;
	let o = A("span", "control-unit");
	o.textContent = n.unit, i.append(a, o);
	let s = A("div", n.range === !0 ? "control-line has-range" : "control-line"), c = {
		label: n.label,
		min: n.min,
		max: n.max
	}, l;
	n.range === !0 && (l = A("input", "range"), l.type = "range", l.min = String(n.min), l.max = String(n.max), l.step = String(n.step), l.value = String(n.initial), l.setAttribute("aria-label", `${n.label}滑块`), s.append(l));
	let u = A("input", "input-number");
	u.id = n.id, u.type = "number", u.min = String(n.min), u.max = String(n.max), u.step = String(n.step), u.value = String(n.initial), u.inputMode = "decimal", u.autocomplete = "off", u.setAttribute("aria-describedby", `${n.id}-hint ${n.id}-state`), s.append(u);
	let d = A("button", "button button-small");
	d.type = "button", d.textContent = "写入", d.setAttribute("aria-label", `写入${n.label}`), s.append(d);
	let f = A("p", "hint");
	f.id = `${n.id}-hint`, f.textContent = n.hint;
	let p = A("p", "control-state");
	p.id = `${n.id}-state`, p.dataset.tone = "idle", p.textContent = n.state, p.setAttribute("aria-live", "polite"), r.append(i, s, f, p), e.append(r);
	let m = !1, h = n.writable, g = !1, _ = (e, t) => {
		p.textContent = e, p.dataset.tone = t;
	}, v = () => {
		u.disabled = g || !h, l !== void 0 && (l.disabled = g || !h), d.disabled = g || !h;
	}, y = (e) => {
		u.value = String(e), l !== void 0 && (l.value = String(e));
	};
	return l?.addEventListener("input", () => {
		m = !0, l !== void 0 && (u.value = l.value);
	}), u.addEventListener("input", () => {
		m = !0, l !== void 0 && Number.isFinite(Number(u.value)) && (l.value = u.value);
	}), d.addEventListener("click", () => {
		(async () => {
			if (g || !h) return;
			let e = t(u.value, c);
			if (!e.ok) {
				_(e.message, "error");
				return;
			}
			d.disabled = !0, _("写入中…", "idle");
			let r = await n.write(e.value);
			g || (v(), r.ok ? (m = !1, y(e.value), _(r.note, "ok")) : _(r.message, "error"));
		})();
	}), n.writable || _("模型未声明对应方法", "error"), v(), {
		root: r,
		sync(e) {
			m || g || y(e);
		},
		setEnabled(e) {
			h = e, v();
		},
		destroy() {
			g = !0, v();
		}
	};
}
var V = [
	"AIN0",
	"AIN1",
	"AIN2",
	"AIN3"
];
function H(e, n, r, i) {
	let a = M(e, "温度 · DS18B20", "1-Wire"), o = B(a, {
		id: "temperature",
		label: "环境温度",
		unit: "°C",
		min: -55,
		max: 125,
		step: .0625,
		initial: 25,
		hint: "0.0625 °C 分辨率；下发后等待下一次 Convert T 才产生转换结果。",
		state: "可写入 · 模型上电默认 25.0 °C",
		writable: i.temperature,
		write: n.writeTemperature
	}), s = N(a, "最近转换（模型回读）"), c = M(e, "模拟输入 · PCF8591", "0–1 归一化");
	P(c, "AIN0–AIN3 独立注入");
	let l = V.map((e, t) => B(c, {
		id: `ain${t}`,
		label: t === 3 ? `${e} · RB2` : e,
		unit: "FS",
		min: 0,
		max: 1,
		step: .01,
		initial: 0,
		range: !0,
		hint: t === 2 ? "独立输入；不随 U26 LM324 输出自动联动。" : "独立注入，范围为 0..1。",
		state: "未下发",
		writable: i.analog,
		write: (e) => n.writeAnalog(t, e)
	})), u = N(c, "最近缓存（模型回读）"), d = M(e, "霍尔 · U21", "开关型"), f = B(d, {
		id: "hall-field",
		label: "外加磁场",
		unit: "mT",
		min: 0,
		max: 1e3,
		step: .1,
		initial: 0,
		hint: "0..1000 mT；输出由板内吸合/释放阈值与迟滞决定。",
		state: "可写入 · 模型上电 0 mT",
		writable: i.hall,
		write: n.writeHall
	}), p = N(d, "输出（模型回读）"), m = M(e, "模拟前端 · U26 LM324", "差分放大"), h = B(m, {
		id: "wiper",
		label: "RB4 滑臂位置",
		unit: "0–1",
		min: 0,
		max: 1,
		step: .001,
		initial: 0,
		range: !0,
		hint: "0 对应约 21×；1 对应约 2001×。实际增益与输出以回读为准。",
		state: "可写入",
		writable: i.wiper,
		write: n.writeWiper
	}), g = A("div", "control"), _ = A("div", "control-head"), v = A("span", "control-label");
	v.textContent = "差分输入 IN+ / IN−";
	let y = A("span", "control-unit");
	y.textContent = "V", _.append(v, y);
	let b = A("div", "pair-line"), x = A("input", "input-number");
	x.id = "amp-plus", x.type = "number", x.min = "0", x.max = "5", x.step = "0.01", x.value = "0", x.inputMode = "decimal", x.autocomplete = "off";
	let S = A("label", "pair-field");
	S.htmlFor = "amp-plus", S.textContent = "IN+";
	let C = A("input", "input-number");
	C.id = "amp-minus", C.type = "number", C.min = "0", C.max = "5", C.step = "0.01", C.value = "0", C.inputMode = "decimal", C.autocomplete = "off";
	let w = A("label", "pair-field");
	w.htmlFor = "amp-minus", w.textContent = "IN−";
	let T = A("button", "button button-small");
	T.type = "button", T.textContent = "写入差分对", b.append(S, x, w, C);
	let E = A("p", "hint");
	E.id = "amp-pair-hint", E.textContent = "两项一次性提交，范围 0..5 V；回读不包含输入电压。";
	let D = A("p", "control-state");
	D.id = "amp-pair-state", D.dataset.tone = "idle", D.textContent = "可写入 · 模型上电默认 0 V / 0 V", D.setAttribute("aria-live", "polite"), x.setAttribute("aria-describedby", "amp-pair-hint amp-pair-state"), C.setAttribute("aria-describedby", "amp-pair-hint amp-pair-state"), g.append(_, b, T, E, D), m.append(g);
	let O = N(m, "增益与输出（模型回读）"), k = !1, j = i.amplifier, L = () => {
		x.disabled = k || !j, C.disabled = k || !j, T.disabled = k || !j;
	}, z = (e, t) => {
		D.textContent = e, D.dataset.tone = t;
	};
	T.addEventListener("click", () => {
		(async () => {
			if (k || !j) return;
			let e = t(x.value, {
				label: "IN+",
				min: 0,
				max: 5
			});
			if (!e.ok) {
				z(e.message, "error");
				return;
			}
			let r = t(C.value, {
				label: "IN−",
				min: 0,
				max: 5
			});
			if (!r.ok) {
				z(r.message, "error");
				return;
			}
			T.disabled = !0, z("写入中…", "idle");
			let i = await n.writeAmplifier(e.value, r.value);
			k || (L(), z(i.ok ? i.note : i.message, i.ok ? "ok" : "error"));
		})();
	}), i.amplifier || z("模型未声明 setAmplifierInputs", "error"), L();
	let H = M(e, "实例属性", "只读"), U = A("dl", "property-list"), W = (e, t) => {
		let n = A("div", "property-row"), r = A("dt");
		r.textContent = e;
		let i = A("dd");
		i.textContent = t, n.append(r, i), U.append(n);
	};
	W("超声波距离", `${F(r.ultrasonicDistanceCm, 1)} cm`), W("系统时钟", R(r.clockFrequency)), W("UART 探针", r.uartBaud === void 0 ? "—" : `${r.uartBaud} baud（8N1）`), H.append(U);
	let G = A("p", "hint");
	G.textContent = "超声波距离是编辑态实例属性；运行中修改需重建实例。本视图不提供伪运行时设定。", H.append(G);
	let K = [
		o,
		f,
		h,
		...l
	];
	return {
		render(e) {
			if (!k) {
				if (e === void 0) s.textContent = "—", u.textContent = "—", p.textContent = "—", O.textContent = "—";
				else {
					s.textContent = e.temperature.converted ? `${F(e.temperature.value, 2)} °C（已转换）` : "尚未转换", u.textContent = e.pcf8591.analog.map((e, t) => `${V[t]}=${F(e, 3)}`).join(" · "), p.textContent = e.hall ? "动作（OUT 拉低）" : "释放（OUT 高阻 / 外部上拉）", O.textContent = `滑臂 ${F(e.amplifier.position, 3)} · 增益 ${I(e.amplifier.gain, 1)}× · 输出 ${F(e.amplifier.outputVoltage, 3)} V`, h.sync(e.amplifier.position);
					for (let t = 0; t < l.length; t += 1) {
						let n = e.pcf8591.analog[t];
						n !== void 0 && l[t]?.sync(n);
					}
				}
			}
		},
		destroy() {
			k = !0;
			for (let e of K) e.destroy();
			L();
		}
	};
}
var U = [
	{
		name: "J13",
		title: "J13 · 写选通",
		purpose: "CON3，默认 2-3",
		options: [{
			closed: !0,
			position: "2-3",
			title: "WR → GND",
			detail: "IO 模式；P42 保留为矩阵列"
		}, {
			closed: !1,
			position: "1-2",
			title: "WR ← P42",
			detail: "Memory 模式；WR 跟随 P42"
		}]
	},
	{
		name: "J5",
		title: "J5 · 键盘列",
		purpose: "CON3，默认 2-3",
		options: [{
			closed: !0,
			position: "2-3",
			title: "S4–S7 → GND",
			detail: "独立键；默认"
		}, {
			closed: !1,
			position: "1-2",
			title: "S4–S7 → P44",
			detail: "并入 4×4 矩阵"
		}]
	},
	{
		name: "J3",
		title: "J3 · 定时输出",
		purpose: "2 脚简化（15–16）",
		options: [{
			closed: !0,
			position: "闭合",
			title: "NET_SIG → P34",
			detail: "NE555 输出接入 P34"
		}, {
			closed: !1,
			position: "断开",
			title: "P34 不连接",
			detail: "不与 NE555 相连"
		}]
	},
	{
		name: "J2",
		title: "J2 · 上排 · 接收",
		purpose: "2–4 / 4–6",
		options: [{
			closed: !0,
			position: "4-6",
			title: "VS1838 → P1.1",
			detail: "选择 U20 接收器；默认"
		}, {
			closed: !1,
			position: "2-4",
			title: "CX20106A → P1.1",
			detail: "选择 U11 接收器"
		}]
	},
	{
		name: "J2Tx",
		title: "J2 · 下排 · 发送",
		purpose: "1–3 / 3–5",
		options: [{
			closed: !1,
			position: "1-3",
			title: "P1.0 → U18",
			detail: "默认"
		}, {
			closed: !0,
			position: "3-5",
			title: "P1.0 → LD1",
			detail: "红外发射管调制"
		}]
	},
	{
		name: "J6",
		title: "J6 · 蜂鸣器旁三针",
		purpose: "装配状态，默认 ON",
		options: [{
			closed: !1,
			position: "OFF",
			title: "左侧未短接",
			detail: "仅装配状态；未确认电气接线"
		}, {
			closed: !0,
			position: "ON",
			title: "右侧短接",
			detail: "仅装配状态；默认；不改变供电/蜂鸣器/继电器"
		}]
	}
], W = [
	{
		name: "LD1",
		title: "LD1 · 发射端",
		detail: "红外载波请求；与接收器独立",
		output: "载波"
	},
	{
		name: "U11",
		title: "U11 · CX20106A",
		detail: "接收器载波输入；J2 选 2-4 时进入 P1.1",
		output: "接收触发"
	},
	{
		name: "U20",
		title: "U20 · VS1838",
		detail: "接收器载波输入；J2 选 4-6 时进入 P1.1",
		output: "接收触发"
	}
];
function G(e, t, n) {
	let r = M(e, "按键 · 17 键", "保持组合"), i = A("div", "toolbar"), a = A("p", "meta");
	a.textContent = "尚未读取模型状态", a.setAttribute("aria-live", "polite");
	let o = A("button", "button button-small");
	o.type = "button", o.textContent = "全部释放", i.append(a, o), r.append(i);
	let s = A("div", "key-reset-row"), c = A("div", "key-grid");
	r.append(s, c);
	let l = /* @__PURE__ */ new Map(), u = (e, t) => {
		let n = l.get(e);
		if (n === void 0) return;
		n.setAttribute("aria-pressed", t === !0 ? "true" : "false");
		let r = n.querySelector(".key-state");
		r !== null && (r.textContent = t === void 0 ? "未知" : t ? "按下" : "松开"), n.classList.toggle("is-pressed", t === !0);
	};
	for (let e of C) {
		let t = A("button", "key");
		t.type = "button", t.dataset.key = e, t.disabled = !0;
		let n = A("span", "key-name");
		n.textContent = e;
		let r = A("span", "key-state");
		r.textContent = "未知", t.append(n, r), e === "S1" ? (t.classList.add("key-reset"), t.setAttribute("title", "S1 接在 VCC 与 RST 之间"), s.append(t)) : c.append(t), l.set(e, t);
	}
	let d = A("p", "hint");
	d.textContent = "点击切换并保持按下；可与跳线组合。照片热区释放的键会在下一次事件中同步。", r.append(d);
	let f = /* @__PURE__ */ new Map(), p = /* @__PURE__ */ new Set(), m = n.keys, h = n.jumpers, g = n.ir, _ = !1, v = !1, y = () => {
		for (let [e, t] of l) t.disabled = v || !m || !_ || p.has(e);
		o.disabled = v || !m || !_;
	}, b = () => {
		if (!_) {
			a.textContent = "尚未读取模型状态";
			return;
		}
		let e = C.filter((e) => f.get(e) === !0);
		a.textContent = e.length === 0 ? "模型按住：无" : `模型按住：${e.join("、")}`, a.dataset.tone = e.length > 0 ? "active" : "idle";
	};
	for (let [e, n] of l) n.addEventListener("click", () => {
		(async () => {
			if (v || !m || !_ || p.has(e)) return;
			let n = f.get(e) !== !0;
			p.add(e), y();
			let r = await t.setSwitch(e, n);
			v || (p.delete(e), r.ok ? (f.set(e, n), u(e, n), b()) : (a.textContent = `${e}：${r.message}`, a.dataset.tone = "error"), y());
		})();
	});
	o.addEventListener("click", () => {
		(async () => {
			if (v || !m || !_) return;
			for (let e of C) f.get(e) === !0 && p.add(e);
			y();
			let e = await t.releaseAll();
			if (!v) {
				if (p.clear(), e.ok) {
					for (let e of C) f.set(e, !1), u(e, !1);
					b();
				} else a.textContent = e.message, a.dataset.tone = "error";
				y();
			}
		})();
	});
	let x = M(e, "跳线 · 装配", "模型方法 setJumper"), S = /* @__PURE__ */ new Map(), E = /* @__PURE__ */ new Map(), D = /* @__PURE__ */ new Set(), O = A("p", "control-state");
	O.dataset.tone = "idle", O.textContent = "尚未读取模型状态", O.setAttribute("aria-live", "polite");
	let k = () => {
		for (let [e, t] of S) t.disabled = v || !h || !_ || D.has(e);
	}, j = (e, t) => {
		let n = S.get(e);
		if (n !== void 0) for (let e of n.querySelectorAll("input[type=\"radio\"]")) e.checked = t !== void 0 && e.value === String(t);
	};
	for (let e of U) {
		let t = A("fieldset", "jumper"), n = A("legend"), r = A("span", "jumper-title");
		r.textContent = e.title;
		let i = A("span", "jumper-purpose");
		i.textContent = e.purpose, n.append(r, i), t.append(n);
		let a = A("div", "jumper-options");
		for (let t of e.options) {
			let n = A("label", "jumper-option"), r = A("input");
			r.type = "radio", r.name = `jumper-${e.name}`, r.value = String(t.closed), r.addEventListener("change", () => {
				r.checked && N(e.name, t.closed);
			});
			let i = A("span", "jumper-option-text"), o = A("span", "jumper-position");
			o.textContent = t.position;
			let s = A("span", "jumper-option-title");
			s.textContent = t.title;
			let c = A("span", "jumper-detail");
			c.textContent = t.detail, i.append(o, s, c), n.append(r, i), a.append(n);
		}
		t.append(a), x.append(t), S.set(e.name, t);
	}
	x.append(O), k();
	async function N(e, n) {
		if (v || !h || !_ || D.has(e)) return;
		D.add(e), k();
		let r = await t.setJumper(e, n);
		v || (D.delete(e), r.ok ? (E.set(e, n), j(e, n), O.textContent = e === "J6" ? `J6 已切换到 ${n ? "ON" : "OFF"}（仅装配状态）` : `${e} 已切换到 ${n ? "闭合位置" : "另一位置"}`, O.dataset.tone = "ok") : (j(e, E.get(e)), O.textContent = `${e}：${r.message}`, O.dataset.tone = "error"), k());
	}
	let P = M(e, "红外 · 独立源", "显式位号"), F = /* @__PURE__ */ new Map(), I = /* @__PURE__ */ new Map(), L = /* @__PURE__ */ new Map(), R = /* @__PURE__ */ new Set(), z = A("p", "hint");
	z.textContent = "LD1 / U11 / U20 可独立注入；J2 上排切换 P1.1 接收源，下排切换 P1.0 发送支路。", P.append(z);
	let B = () => {
		for (let [e, t] of F) t.disabled = v || !g || !_ || R.has(e);
	}, V = (e, t) => {
		let n = F.get(e);
		if (n !== void 0) {
			n.setAttribute("aria-pressed", t === !0 ? "true" : "false"), n.classList.toggle("is-pressed", t === !0);
			let e = n.querySelector(".switch-state");
			e !== null && (e.textContent = t === void 0 ? "未知" : t ? "开启" : "关闭");
		}
		let r = I.get(e);
		r !== void 0 && (r.textContent = t === void 0 ? "—" : t ? "开启 / 触发" : "关闭 / 未触发");
	};
	for (let e of W) {
		let n = A("div", "switch-row"), r = A("button", "switch");
		r.type = "button", r.dataset.ir = e.name, r.disabled = !0;
		let i = A("span", "switch-name");
		i.textContent = e.title;
		let a = A("span", "switch-state");
		a.textContent = "未知", r.append(i, a);
		let o = A("span", "switch-detail");
		o.textContent = e.detail;
		let s = A("span", "switch-readback");
		s.textContent = `${e.output}：—`, n.append(r, o, s), P.append(n), F.set(e.name, r), I.set(e.name, s), r.addEventListener("click", () => {
			(async () => {
				if (v || !g || !_ || R.has(e.name)) return;
				let n = L.get(e.name) !== !0;
				R.add(e.name), B();
				let r = await t.setIr(e.name, n);
				v || (R.delete(e.name), r.ok ? (L.set(e.name, n), V(e.name, n), z.textContent = "LD1 / U11 / U20 可独立注入；J2 上排切换 P1.1 接收源，下排切换 P1.0 发送支路。", z.dataset.tone = "idle") : (V(e.name, L.get(e.name)), z.textContent = `${e.name}：${r.message}`, z.dataset.tone = "error"), B());
			})();
		});
	}
	return B(), {
		render(e) {
			if (!v) {
				if (e === void 0) {
					_ = !1;
					for (let e of C) u(e, void 0);
					b(), O.textContent = "尚未读取模型状态", O.dataset.tone = "idle";
					for (let e of w) j(e, void 0);
					for (let e of T) V(e, void 0);
				} else {
					_ = !0;
					for (let t of C) {
						let n = e.switches[t];
						f.set(t, n), u(t, n);
					}
					b();
					for (let t of w) {
						let n = e.jumpers[t];
						E.set(t, n), j(t, n);
					}
					for (let t of T) {
						let n = e.infrared[t];
						L.set(t, n), V(t, n);
					}
					O.textContent = "J6 仅记录装配状态；其他跳线位置变更立即重算当前按住的键。", O.dataset.tone = "idle";
				}
				y(), k(), B();
			}
		},
		destroy() {
			v = !0, y(), k(), B();
		}
	};
}
function K(e, t, n, r, i) {
	let a = M(e, "板级状态", "初始快照 + 事件"), s = A("dl", "readout-list"), c = {};
	for (let { key: e, label: t } of [
		{
			key: "latches",
			label: "锁存器 U6–U9"
		},
		{
			key: "decoder",
			label: "译码器 U24"
		},
		{
			key: "uln2003",
			label: "驱动 U10"
		},
		{
			key: "actuators",
			label: "执行器 K1 / SP1"
		},
		{
			key: "lm386",
			label: "音频 U14"
		},
		{
			key: "hall",
			label: "霍尔 U21"
		},
		{
			key: "temperature",
			label: "温度 U5"
		},
		{
			key: "amplifier",
			label: "放大器 U26"
		}
	]) {
		let n = A("div", "readout-row"), r = A("dt");
		r.textContent = t;
		let i = A("dd");
		i.textContent = "尚未读取", i.dataset.readout = e, n.append(r, i), s.append(n), c[e] = i;
	}
	a.append(s);
	let l = M(t, "EEPROM · U4 AT24C02", "256 字节"), u = A("p", "meta");
	u.textContent = "尚未读取";
	let d = A("pre", "hex-dump");
	d.textContent = "尚未读取 EEPROM", d.setAttribute("tabindex", "0"), d.setAttribute("aria-label", "AT24C02 EEPROM 十六进制转储"), l.append(u, d);
	let f = M(n, "RTC · U19 DS1302", "实时时钟"), p = A("dl", "readout-list"), m = A("dd");
	m.textContent = "尚未读取";
	let h = A("dd");
	h.textContent = "尚未读取";
	let g = (e, t) => {
		let n = A("div", "readout-row"), r = A("dt");
		r.textContent = e, n.append(r, t), p.append(n);
	};
	g("日期时间", m), g("走时", h);
	let _ = A("p", "meta");
	_.textContent = "尚未读取", f.append(p, _);
	let v = !1;
	return {
		refreshButton: i,
		render(e) {
			if (!v) {
				if (e === void 0) for (let e of Object.keys(c)) c[e].textContent = "尚未读取";
				else c.latches.textContent = [
					`U6 ${L(e.latches.U6)}`,
					`U7 ${L(e.latches.U7)}`,
					`U8 ${L(e.latches.U8)}`,
					`U9 ${L(e.latches.U9)}`
				].join(" · "), c.decoder.textContent = `${e.decoder.select < 0 ? "禁用" : `Y${e.decoder.select}`} · ${e.decoder.enabled ? "使能" : "禁止"} · ${e.decoder.code}`, c.uln2003.textContent = `mask 0x${e.uln2003.mask.toString(16).padStart(2, "0").toUpperCase()} · ${e.uln2003.channels}`, c.actuators.textContent = `K1 ${e.relay ? "吸合" : "断开"} · SP1 ${e.buzzer ? "发声" : "静音"}`, c.lm386.textContent = e.lm386.active ? "活动" : "未活动", c.hall.textContent = e.hall ? "动作" : "释放", c.temperature.textContent = e.temperature.converted ? `${F(e.temperature.value, 2)} °C（已转换）` : "尚未转换", c.amplifier.textContent = `增益 ${I(e.amplifier.gain, 1)}× · 输出 ${F(e.amplifier.outputVoltage, 3)} V`;
			}
		},
		renderEeprom(e, t, n) {
			if (v) return;
			if (e === void 0) {
				u.textContent = "尚未读取", d.textContent = "尚未读取 EEPROM";
				return;
			}
			if (e.length === 0) {
				u.textContent = `${n} ${t} · 0 字节`, d.textContent = "模型尚无 EEPROM 快照（0 字节）";
				return;
			}
			let r = o(e, 8);
			d.textContent = r.map((e) => `${e.offset}  ${e.hex.padEnd(23, " ")}  ${e.ascii}`).join("\n");
			let i = 0;
			for (let t of e) t !== 0 && (i += 1);
			u.textContent = `${e.length} B · 非零 ${i} · ${n} ${t}`;
		},
		renderRtc(e, t) {
			v || (e === void 0 ? (m.textContent = "尚未读取", h.textContent = "尚未读取", _.textContent = "尚未读取") : (m.textContent = e.datetime.length === 0 ? "—（尚未发布）" : e.datetime, h.textContent = e.running ? "运行" : "停止", _.textContent = `读取 ${t}`));
		},
		setQueryTime(e) {
			v || (r.textContent = e);
		},
		setBusy(e) {
			v || (i.disabled = e, i.textContent = e ? "读取中…" : "重读全部");
		},
		destroy() {
			v = !0, i.disabled = !0;
		}
	};
}
var q = 320, J = 32;
function Y(e, t, o, c) {
	let l = !1, u = "", d = A("p", "serial-line"), f = [];
	c.hasTxEvent || f.push("TX 事件未声明"), c.hasRxEvent || f.push("RX 事件未声明"), d.textContent = `8N1${c.baud === void 0 ? "" : ` · ${c.baud} baud`} · 单次 ≤ 64 字节 · 不自动拆包${f.length === 0 ? "" : ` · ${f.join(" / ")}`}`, e.append(d);
	let p = A("form", "send-form");
	p.noValidate = !0;
	let m = A("div", "mode-row");
	m.setAttribute("role", "radiogroup"), m.setAttribute("aria-label", "发送格式");
	let g = A("input");
	g.type = "radio", g.name = "send-mode", g.value = "utf8", g.checked = !0;
	let _ = A("label", "radio-inline");
	_.append(g, document.createTextNode("UTF-8"));
	let v = A("input");
	v.type = "radio", v.name = "send-mode", v.value = "hex";
	let y = A("label", "radio-inline");
	y.append(v, document.createTextNode("HEX")), m.append(_, y);
	let b = A("label", "field-label");
	b.htmlFor = "send-text", b.textContent = "发送内容";
	let x = A("textarea", "send-input");
	x.id = "send-text", x.rows = 3, x.spellcheck = !1, x.autocomplete = "off", x.autocapitalize = "off", x.setAttribute("aria-describedby", "send-hint send-error");
	let S = A("div", "send-summary"), C = A("span", "meta");
	C.textContent = "0 / 64 字节";
	let w = A("code", "send-preview");
	S.append(C, w);
	let T = A("p", "hint");
	T.id = "send-hint";
	let E = A("p", "field-error");
	E.id = "send-error", E.setAttribute("role", "alert"), E.hidden = !0;
	let D = A("div", "send-actions"), O = A("button", "button button-primary");
	O.type = "submit", O.textContent = "发送";
	let k = A("button", "button");
	k.type = "button", k.textContent = "清空";
	let j = A("span", "meta");
	j.setAttribute("role", "status"), D.append(O, k, j), p.append(m, b, x, S, T, E, D), t.append(p), c.hasSend || (O.disabled = !0, k.disabled = !0, x.disabled = !0, g.disabled = !0, v.disabled = !0, T.textContent = "模型未声明 sendUart，无法发送。", T.dataset.tone = "error");
	let M = () => v.checked ? "hex" : "utf8", N = () => M() === "hex" ? r(x.value) : n(x.value), P = () => {
		c.hasSend && (T.textContent = M() === "hex" ? "每字节两位十六进制，空白仅作分隔；最多 64 字节；不接受 0x 前缀。" : "按 UTF-8 编码后最多 64 字节；换行和中文都按实际字节计数。", T.dataset.tone = "idle");
	}, F = !1, I = () => {
		let e = N();
		return c.hasSend ? x.value.length === 0 ? (C.textContent = "0 / 64 字节", w.textContent = "", E.hidden = !0, x.setAttribute("aria-invalid", "false"), O.disabled = !0, e) : (e.ok ? (C.textContent = `${e.bytes.length} / 64 字节`, w.textContent = i(e.bytes, 24), E.hidden = !0, x.setAttribute("aria-invalid", "false"), O.disabled = F) : (C.textContent = "— / 64 字节", w.textContent = "", E.textContent = e.message, E.hidden = !1, x.setAttribute("aria-invalid", "true"), O.disabled = !0), e) : e;
	}, L = () => {
		l || (P(), I());
	};
	g.addEventListener("change", L), v.addEventListener("change", L), x.addEventListener("input", () => {
		l || I();
	}), x.addEventListener("keydown", (e) => {
		e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), p.requestSubmit());
	}), k.addEventListener("click", () => {
		l || (x.value = "", j.textContent = "", I(), x.focus());
	}), p.addEventListener("submit", (e) => {
		e.preventDefault(), (async () => {
			if (l || F || !c.hasSend) return;
			let e = I();
			if (!e.ok || e.bytes.length === 0) return;
			F = !0, O.disabled = !0, g.disabled = !0, v.disabled = !0, x.disabled = !0, j.textContent = "发送中…";
			let t = await c.send(e.bytes);
			l || (F = !1, g.disabled = !1, v.disabled = !1, x.disabled = !1, t.ok ? (u = z(), j.textContent = `${t.note} · ${u}`, E.hidden = !0, x.setAttribute("aria-invalid", "false"), I()) : (j.textContent = "", E.textContent = t.message, E.hidden = !1, x.setAttribute("aria-invalid", "true"), O.disabled = !0));
		})();
	}), P(), I();
	let R = {
		uart1Tx: B("uart1Tx", "TX", "发送记录"),
		uart1Rx: B("uart1Rx", "RX", "接收记录")
	};
	function B(e, t, n) {
		let r = A("section", "log-block"), i = A("div", "log-head"), a = A("h3");
		a.textContent = `${t} · ${n}`;
		let c = A("span", "log-count");
		c.textContent = "0 B";
		let u = A("button", "button button-small");
		u.type = "button", u.textContent = "跳到最新", u.hidden = !0;
		let d = A("button", "button button-small");
		d.type = "button", d.textContent = "清屏", d.setAttribute("title", "只清空显示，不改变模型历史与游标"), i.append(a, c, u, d);
		let f = A("p", "log-stats");
		f.textContent = "cursor — · 保留 — · 模型丢弃 —";
		let p = A("div", "log");
		p.setAttribute("role", "log"), p.setAttribute("aria-live", "off"), p.setAttribute("aria-label", `${t} ${n}`), p.tabIndex = 0;
		let m = A("p", "log-empty");
		m.textContent = "等待数据…", p.append(m), r.append(i, f, p), o.append(r);
		let h = {
			name: e,
			label: t,
			ledger: new s(4096),
			log: p,
			stats: f,
			count: c,
			jump: u,
			pending: [],
			initialized: !1,
			frame: void 0,
			status: void 0,
			statusInFlight: !1,
			statusDirty: !1,
			visibleBytes: 0,
			trimmedRows: 0,
			statusReported: !1
		}, g = () => p.scrollHeight - p.scrollTop - p.clientHeight < 24;
		return p.addEventListener("scroll", () => {
			l || (u.hidden = g());
		}), u.addEventListener("click", () => {
			p.scrollTop = p.scrollHeight, u.hidden = !0;
		}), d.addEventListener("click", () => {
			if (l) return;
			p.replaceChildren();
			let e = A("p", "log-empty");
			e.textContent = "已清屏；模型历史与游标未改变。", p.append(e), h.visibleBytes = 0, h.trimmedRows = 0, c.textContent = "0 B", u.hidden = !0;
		}), h;
	}
	function V(e) {
		e.count.textContent = e.trimmedRows === 0 ? `${e.visibleBytes} B` : `${e.visibleBytes} B · 已隐藏 ${e.trimmedRows} 行`;
	}
	function H(e, t, n, r) {
		if (l) return;
		let o = e.log, s = o.querySelector(".log-empty");
		s !== null && s.remove();
		let c = o.scrollHeight - o.scrollTop - o.clientHeight < 24 || o.scrollHeight === 0, u = A("div", r === void 0 ? "log-entry" : "log-system");
		if (r !== void 0) u.textContent = r;
		else if (t !== void 0) {
			let r = A("span", "log-time");
			r.textContent = h(n);
			let o = A("code", "log-hex");
			o.textContent = i(t);
			let s = A("span", "log-ascii");
			s.textContent = a(t), u.append(r, o, s), e.visibleBytes += t.length;
		}
		for (o.append(u); o.childElementCount > q;) {
			let t = o.firstElementChild;
			if (t === null) break;
			t.remove(), e.trimmedRows += 1;
		}
		V(e), c ? (o.scrollTop = o.scrollHeight, e.jump.hidden = !0) : e.jump.hidden = !1;
	}
	function U(e, t, n) {
		for (let r = 0; r < t.length; r += J) H(e, t.subarray(r, r + J), n, void 0);
	}
	function W(e, t) {
		H(e, void 0, void 0, t);
	}
	function G(e) {
		if (l) return;
		let t = e.status;
		if (t === void 0) {
			e.statusReported || (e.stats.textContent = c.hasStatus ? "cursor — · 保留 — · 模型丢弃 —" : "模型未声明 getSerialStatus");
			return;
		}
		e.statusReported = !0;
		let n = [];
		e.ledger.droppedBytes > 0 && n.push(`补读跳过 ${e.ledger.droppedBytes}`), e.ledger.gapBytes > 0 && n.push(`未接续 ${e.ledger.gapBytes}`), e.stats.textContent = `next ${t.next} / 保留 ${t.oldest}..${t.next} · 容量 ${t.capacity} · 模型丢弃 ${t.droppedTotal}${n.length === 0 ? "" : ` · ${n.join(" · ")}`}`;
	}
	async function K(e) {
		if (!l && c.hasStatus) {
			if (e.statusInFlight) e.statusDirty = !0;
			else {
				e.statusInFlight = !0;
				do {
					e.statusDirty = !1;
					let t = await c.status(e.name);
					if (l) {
						e.statusInFlight = !1;
						return;
					}
					t.ok && (e.status = t.value, G(e));
				} while (e.statusDirty && !l);
				e.statusInFlight = !1;
			}
		}
	}
	function Y(e) {
		if (l || (e.frame = void 0, !e.initialized)) return;
		let t = e.pending.splice(0);
		if (t.length === 0) return;
		let n = [], r = 0, i, a = !1;
		for (let o of t) {
			let t = e.ledger.ingest({
				start: o.cursor,
				data: o.data
			});
			t.gapBytes > 0 && (W(e, `游标未接续 ${t.gapBytes} 字节（实时事件缺口）`), a = !0), t.appended.length > 0 && (n.push(t.appended), r += t.appended.length, i = o.simTime, a = !0);
		}
		if (r > 0) {
			let t = new Uint8Array(r), a = 0;
			for (let e of n) t.set(e, a), a += e.length;
			U(e, t, i);
		}
		a && K(e);
	}
	function X(e) {
		!l && e.frame === void 0 && e.initialized && (e.frame = requestAnimationFrame(() => Y(e)));
	}
	async function Z(e) {
		if (e.initialized) return;
		if (!c.hasRead) {
			W(e, "模型未声明 readSerial；只显示订阅后的实时字节。"), e.initialized = !0, Y(e), K(e);
			return;
		}
		let t = await c.read(e.name, 0);
		if (!l) {
			if (e.initialized = !0, t.ok) {
				let n = e.ledger.ingest({
					start: t.value.start,
					data: t.value.data,
					dropped: t.value.dropped
				});
				t.value.dropped > 0 && W(e, `补读时模型已裁剪 ${t.value.dropped} 字节更早历史`), n.gapBytes > 0 && W(e, `补读未接续 ${n.gapBytes} 字节`), n.appended.length > 0 && U(e, n.appended, void 0);
			} else W(e, `补读历史失败：${t.message}`);
			Y(e), K(e);
		}
	}
	return {
		ingest(e, t, n) {
			if (l) return;
			let r = R[e];
			r.pending.push({
				cursor: t.cursor,
				data: t.data.slice(),
				simTime: n
			}), r.initialized && X(r);
		},
		async initialize() {
			await Promise.all([Z(R.uart1Tx), Z(R.uart1Rx)]);
		},
		destroy() {
			l = !0;
			for (let e of Object.values(R)) e.frame !== void 0 && (cancelAnimationFrame(e.frame), e.frame = void 0);
			O.disabled = !0, k.disabled = !0, x.disabled = !0, g.disabled = !0, v.disabled = !0;
		}
	};
}
function X() {
	return {
		app: j("app"),
		identity: j("identity-line"),
		connectionState: j("connection-state"),
		connectionLabel: j("connection-label"),
		notice: j("notice"),
		errorBanner: j("error-banner"),
		errorText: j("error-text"),
		errorDismiss: j("error-dismiss"),
		inputHost: j("input-groups"),
		assemblyHost: j("assembly-groups"),
		serialStatusHost: j("serial-status"),
		serialSendHost: j("serial-send"),
		serialLogsHost: j("serial-logs"),
		statusReadoutsHost: j("status-readouts"),
		eepromHost: j("eeprom-host"),
		rtcHost: j("rtc-host"),
		queryTime: j("query-time"),
		refreshStatus: j("refresh-status"),
		fatal: j("fatal"),
		fatalText: j("fatal-text")
	};
}
function Z(e, t, n) {
	e.connectionState.dataset.tone = t, e.connectionLabel.textContent = n;
}
function ee(e, t) {
	e.errorText.textContent = t, e.errorBanner.hidden = !1;
}
function Q(e, t) {
	e.notice.textContent = t, e.notice.hidden = !1;
}
function $(e) {
	let t = document.getElementById("app"), n = document.getElementById("fatal"), r = document.getElementById("fatal-text");
	t !== null && (t.hidden = !0), n !== null && (n.hidden = !1), r !== null && (r.textContent = e);
}
function te(e) {
	for (let t of e.querySelectorAll("input, button, textarea, select")) t.disabled = !0;
}
async function ne() {
	if (typeof acquireDeviceViewApi != "function") {
		$("此页面需要在器件 HTML 视图环境中打开：未找到 acquireDeviceViewApi 桥接。");
		return;
	}
	let e;
	try {
		e = await acquireDeviceViewApi();
	} catch (e) {
		$(`获取视图桥接失败：${f(e)}`);
		return;
	}
	let t = X();
	re(e, t);
}
function re(e, t) {
	let n = e.model, r = m(n), i = e.props, a = new d(), o = new k(), s = new u(), l = new u(), f = new u(), h = new u(), g = new c(), _ = new c(), v, y, b = async (e, n) => {
		if (a.closed) return {
			ok: !1,
			message: "视图已关闭"
		};
		let r = await p(n);
		return r.ok ? a.closed ? {
			ok: !1,
			message: "视图已关闭"
		} : r : (a.closed || ee(t, `${e}：${r.message}`), r);
	}, x = [
		`MCU ${R(i.clockFrequency)}`,
		`UART ${i.uartBaud} 8N1`,
		`超声 ${F(i.ultrasonicDistanceCm, 1)} cm（属性）`
	];
	t.identity.textContent = x.join(" · "), t.app.setAttribute("aria-busy", "true"), t.errorDismiss.addEventListener("click", () => {
		t.errorBanner.hidden = !0;
	}), r === void 0 ? (Z(t, "pending", "连接中"), t.refreshStatus.disabled = !0) : (Z(t, "unavailable", "无运行模型"), Q(t, r), t.refreshStatus.disabled = !0);
	let w = H(t.inputHost, {
		async writeTemperature(e) {
			return n === void 0 ? {
				ok: !1,
				message: "模型不可用"
			} : O("写入温度", () => n.methods.setTemperature({ value: e }), `已下发 ${I(e, 4)} °C`);
		},
		async writeAnalog(e, t) {
			if (n === void 0) return {
				ok: !1,
				message: "模型不可用"
			};
			let r = await O(`写入 AIN${e}`, () => n.methods.setAnalogInput({
				channel: e,
				value: t
			}), `已下发 AIN${e} = ${t.toFixed(3)}`);
			return r.ok && e !== 3 && o.setAnalog(e, t), r;
		},
		async writeHall(e) {
			return n === void 0 ? {
				ok: !1,
				message: "模型不可用"
			} : O("写入霍尔磁场", () => n.methods.setHallField({ value: e }), `已下发 ${I(e, 4)} mT`);
		},
		async writeWiper(e) {
			return n === void 0 ? {
				ok: !1,
				message: "模型不可用"
			} : O("写入滑臂位置", () => n.methods.setWiper({ value: e }), `已下发滑臂 ${e.toFixed(3)}`);
		},
		async writeAmplifier(e, t) {
			return n === void 0 ? {
				ok: !1,
				message: "模型不可用"
			} : O("写入差分输入", () => n.methods.setAmplifierInputs({
				plus: e,
				minus: t
			}), `已下发 IN+ ${I(e, 3)} V / IN− ${I(t, 3)} V`);
		}
	}, i, {
		temperature: n !== void 0,
		analog: n !== void 0,
		hall: n !== void 0,
		wiper: n !== void 0,
		amplifier: n !== void 0
	}), T = G(t.assemblyHost, {
		async setSwitch(e, t) {
			if (n === void 0) return {
				ok: !1,
				message: "模型不可用"
			};
			let r = await O(`切换 ${e}`, () => n.methods.setSwitch({
				designator: e,
				pressed: t
			}), `${e} ${t ? "按下" : "松开"}`);
			return r.ok && o.setSwitch(e, t), r;
		},
		async setJumper(e, t) {
			if (n === void 0) return {
				ok: !1,
				message: "模型不可用"
			};
			let r = await O(`切换跳线 ${e}`, () => n.methods.setJumper(S(e, t)), `${e} ${t ? "闭合" : "切换"}`);
			return r.ok && o.setJumper(e, t), r;
		},
		async setIr(e, t) {
			if (n === void 0) return {
				ok: !1,
				message: "模型不可用"
			};
			let r = await O(`切换红外源 ${e}`, () => n.methods.setIrCarrier({
				designator: e,
				value: t
			}), `${e} ${t ? "开启" : "关闭"}`);
			return r.ok && o.setIr(e, t), r;
		},
		async releaseAll() {
			if (n === void 0) return {
				ok: !1,
				message: "模型不可用"
			};
			let e = o.readback;
			if (e === void 0) return {
				ok: !1,
				message: "尚未读取模型状态"
			};
			let t = C.filter((t) => e.switches[t] === !0);
			if (t.length === 0) return {
				ok: !0,
				note: "当前没有按下的键"
			};
			let r = [];
			for (let e of t) {
				let t = await O(`释放 ${e}`, () => n.methods.setSwitch({
					designator: e,
					pressed: !1
				}), `${e} 松开`);
				t.ok ? o.setSwitch(e, !1) : r.push(`${e}：${t.message}`);
			}
			return r.length === 0 ? {
				ok: !0,
				note: `已释放 ${t.length} 个按键`
			} : {
				ok: !1,
				message: `部分按键未释放：${r.join("；")}`
			};
		}
	}, {
		keys: n !== void 0,
		jumpers: n !== void 0,
		ir: n !== void 0
	}), E = K(t.statusReadoutsHost, t.eepromHost, t.rtcHost, t.queryTime, t.refreshStatus), D = Y(t.serialStatusHost, t.serialSendHost, t.serialLogsHost, {
		baud: i.uartBaud,
		hasRead: n !== void 0,
		hasStatus: n !== void 0,
		hasSend: n !== void 0,
		hasTxEvent: n !== void 0,
		hasRxEvent: n !== void 0,
		read: async (e, t) => n === void 0 ? {
			ok: !1,
			message: "模型不可用"
		} : b(`读取 ${e} 历史`, () => n.methods.readSerial({
			channel: e,
			cursor: t
		})),
		status: async (e) => n === void 0 ? {
			ok: !1,
			message: "模型不可用"
		} : b(`读取 ${e} 状态`, () => n.methods.getSerialStatus({ channel: e })),
		send: async (e) => {
			if (n === void 0) return {
				ok: !1,
				message: "模型不可用"
			};
			let t = await b("发送串口数据", () => n.methods.sendUart({ data: e }));
			return t.ok ? {
				ok: !0,
				note: `已发送 ${e.length} 字节`
			} : {
				ok: !1,
				message: t.message
			};
		}
	});
	t.refreshStatus.addEventListener("click", () => {
		W();
	}), J(), a.track(e.onDidClose(() => X())), M(), q();
	async function O(e, t, n) {
		let r = await b(e, t);
		return r.ok ? {
			ok: !0,
			note: n
		} : {
			ok: !1,
			message: r.message
		};
	}
	function A() {
		a.closed || y !== void 0 || (y = requestAnimationFrame(() => {
			y = void 0, a.closed || j();
		}));
	}
	function j() {
		let e = o.readback;
		w.render(e), T.render(e), E.render(e);
	}
	function M() {
		n !== void 0 && (a.track(n.events.onDidSignal((e) => {
			a.closed || N(e.value);
		})), a.track(n.events.onDidBytes((e) => {
			a.closed || P(e.value);
		})), a.track(n.events.onDidAmplifier((e) => {
			a.closed || L(e.value);
		})), a.track(n.events.onDidUart1Tx((e) => {
			a.closed || D.ingest("uart1Tx", e.value, e.simTime);
		})), a.track(n.events.onDidUart1Rx((e) => {
			a.closed || D.ingest("uart1Rx", e.value, e.simTime);
		})));
	}
	function N(e) {
		e.designator === "U19" && e.port === "running" && (_.bump("rtc.running"), v = {
			datetime: v?.datetime ?? "",
			running: e.value !== 0
		}, E.renderRtc(v, z())), o.applySignal(e) && A();
	}
	function P(e) {
		let { designator: t, port: n, data: r } = e;
		t === "U4" && n === "dump" ? (g.bump("eeprom"), E.renderEeprom(r, z(), "事件更新")) : t === "U19" && n === "datetime" ? (_.bump("rtc.datetime"), v = {
			datetime: new TextDecoder().decode(r),
			running: v?.running ?? !1
		}, E.renderRtc(v, z())) : o.applyBytes(e) && A();
	}
	function L(e) {
		o.applyAmplifier(e) && A();
	}
	async function B() {
		if (n === void 0) return !1;
		let e = s.start(), t = o.beginSnapshot(), r = await b("读取状态快照", () => n.methods.getSnapshot(null));
		return a.closed || !s.isCurrent(e) || !r.ok || !o.applySnapshot(r.value, t) ? !1 : (j(), !0);
	}
	async function V() {
		if (n === void 0) return;
		let e = l.start(), t = g.snapshot(), r = await b("读取 EEPROM", () => n.methods.getEeprom(null));
		!a.closed && l.isCurrent(e) && r.ok && g.isUnchanged("eeprom", t) && E.renderEeprom(r.value, z(), "手动读取");
	}
	async function U() {
		if (n === void 0) return;
		let e = f.start(), t = _.snapshot(), r = await b("读取 RTC", () => n.methods.getRtc(null));
		if (a.closed || !f.isCurrent(e) || !r.ok) return;
		let i = v;
		v = i === void 0 ? r.value : {
			datetime: _.isUnchanged("rtc.datetime", t) ? r.value.datetime : i.datetime,
			running: _.isUnchanged("rtc.running", t) ? r.value.running : i.running
		}, E.renderRtc(v, z());
	}
	async function W() {
		if (a.closed || n === void 0) return;
		let e = h.start();
		E.setBusy(!0);
		try {
			if (await B(), a.closed || !h.isCurrent(e) || (await V(), a.closed || !h.isCurrent(e)) || (await U(), a.closed || !h.isCurrent(e))) return;
			E.setQueryTime(`最近查询 ${z()} · 快照 + EEPROM + RTC`);
		} finally {
			!a.closed && h.isCurrent(e) && E.setBusy(!1);
		}
	}
	async function q() {
		if (n === void 0) {
			t.app.setAttribute("aria-busy", "false"), E.render(void 0);
			return;
		}
		Z(t, "pending", "读取初始状态");
		let e = h.start(), r = await B();
		a.closed || (r || (T.render(void 0), w.render(void 0), E.render(void 0)), t.app.setAttribute("aria-busy", "false"), Z(t, "ready", "已连接"), t.refreshStatus.disabled = !1, await D.initialize(), a.closed || (await V(), a.closed || (await U(), !a.closed && h.isCurrent(e) && E.setQueryTime(`最近查询 ${z()} · 初始快照 + EEPROM + RTC`))));
	}
	function J() {
		let e = Array.from(document.querySelectorAll("[role=\"tab\"]")), t = Array.from(document.querySelectorAll("[role=\"tabpanel\"]"));
		if (e.length === 0 || t.length === 0) return;
		let n = (n, r = !1) => {
			for (let t of e) {
				let e = t === n;
				t.setAttribute("aria-selected", e ? "true" : "false"), t.tabIndex = e ? 0 : -1;
			}
			for (let e of t) e.hidden = e.id !== n.getAttribute("aria-controls");
			r && n.focus();
		};
		for (let t of e) t.addEventListener("click", () => {
			n(t);
		});
		(e[0]?.parentElement)?.addEventListener("keydown", (t) => {
			let r = e.findIndex((e) => e.getAttribute("aria-selected") === "true");
			if (r < 0) return;
			let i;
			if (t.key === "ArrowRight") i = (r + 1) % e.length;
			else if (t.key === "ArrowLeft") i = (r - 1 + e.length) % e.length;
			else if (t.key === "Home") i = 0;
			else if (t.key === "End") i = e.length - 1;
			else return;
			t.preventDefault();
			let a = e[i];
			a !== void 0 && n(a, !0);
		});
		let r = e[0];
		r !== void 0 && n(r);
	}
	function X() {
		if (!a.closed) {
			h.invalidate(), s.invalidate(), l.invalidate(), f.invalidate(), o.close(), y !== void 0 && cancelAnimationFrame(y), y = void 0, D.destroy(), w.destroy(), T.destroy(), E.destroy();
			try {
				a.close();
			} catch (e) {
				console.error("[zerobit-lab:ct107d] 控制面板清理失败", e);
			}
			te(t.app), t.app.setAttribute("aria-busy", "false"), Z(t, "closed", "已关闭"), Q(t, "视图已关闭；模型订阅与本地计时已释放。");
		}
	}
}
typeof document < "u" && ne().catch((e) => {
	$(`控制面板初始化失败：${f(e)}`);
});
export { k as BoardBootstrap, T as IR_NAMES, w as JUMPER_NAMES, C as KEY_NAMES };
