// src/board-layout.ts
var e = {
	x: 93,
	y: 69
}, t = {
	width: 863,
	height: 617
}, n = 11 / 2.54, r = 1 / n;
function i(e) {
	return Math.round(e * 1e6) / 1e6;
}
i(t.width * r), i(t.height * r);
function a(t) {
	return {
		x: t.x * n + e.x,
		y: t.y * n + e.y
	};
}
var o = 36;
function s(e, t, n) {
	return {
		designator: e,
		x: t - o / 2,
		y: n - o / 2,
		width: o,
		height: o
	};
}
var c = [
	s("S7", 145, 485),
	s("S6", 145, 535),
	s("S5", 145, 584),
	s("S4", 145, 633),
	s("S11", 204, 485),
	s("S10", 204, 535),
	s("S9", 204, 583),
	s("S8", 205, 633),
	s("S15", 263, 485),
	s("S14", 262, 534),
	s("S13", 262, 583),
	s("S12", 263, 632),
	s("S19", 321, 484),
	s("S18", 321, 534),
	s("S17", 321, 583),
	s("S16", 321, 632),
	s("S1", 378, 536)
], l = [{
	designator: "DS1",
	x: 502,
	y: 206,
	width: 126,
	height: 60
}, {
	designator: "DS2",
	x: 636,
	y: 206,
	width: 127,
	height: 60
}], u = [
	{
		designator: "D1",
		x: 338.5,
		y: 319
	},
	{
		designator: "D2",
		x: 358.5,
		y: 319
	},
	{
		designator: "D3",
		x: 378,
		y: 319
	},
	{
		designator: "D4",
		x: 398,
		y: 319
	},
	{
		designator: "D5",
		x: 417.5,
		y: 319
	},
	{
		designator: "D6",
		x: 437,
		y: 319
	},
	{
		designator: "D7",
		x: 457,
		y: 319
	},
	{
		designator: "D8",
		x: 476.5,
		y: 319
	}
], d = {
	designator: "SP1",
	x: 688,
	y: 360,
	width: 60,
	height: 60
}, f = {
	designator: "K1",
	x: 762,
	y: 358,
	width: 88,
	height: 62
}, p = [
	{
		designator: "J13",
		hit: {
			x: 289,
			y: 370,
			width: 42,
			height: 72
		},
		socket: {
			x: 298,
			y: 374,
			width: 18,
			height: 40
		},
		pins: [
			{
				pin: 1,
				x: 307,
				y: 403
			},
			{
				pin: 2,
				x: 307,
				y: 391
			},
			{
				pin: 3,
				x: 307,
				y: 379
			}
		],
		options: [{
			closed: !1,
			pins: [1, 2]
		}, {
			closed: !0,
			pins: [2, 3]
		}],
		toggle: !1,
		slider: {
			orientation: "vertical",
			track: {
				x: 302,
				y: 376,
				width: 10,
				height: 36
			},
			knob: {
				width: 12,
				height: 10
			},
			off: {
				x: 307,
				y: 397
			},
			on: {
				x: 307,
				y: 385
			}
		}
	},
	{
		designator: "J5",
		hit: {
			x: 350,
			y: 660,
			width: 44,
			height: 24
		},
		socket: {
			x: 352,
			y: 661,
			width: 42,
			height: 22
		},
		pins: [
			{
				pin: 1,
				x: 357,
				y: 672
			},
			{
				pin: 2,
				x: 371,
				y: 672
			},
			{
				pin: 3,
				x: 385,
				y: 672
			}
		],
		options: [{
			closed: !1,
			pins: [1, 2]
		}, {
			closed: !0,
			pins: [2, 3]
		}],
		toggle: !1,
		slider: {
			orientation: "horizontal",
			track: {
				x: 354,
				y: 667,
				width: 38,
				height: 10
			},
			knob: {
				width: 13,
				height: 11
			},
			off: {
				x: 364,
				y: 672
			},
			on: {
				x: 378,
				y: 672
			}
		}
	},
	{
		designator: "J3",
		hit: {
			x: 926,
			y: 454,
			width: 28,
			height: 30
		},
		socket: {
			x: 933,
			y: 459,
			width: 14,
			height: 19
		},
		pins: [{
			pin: 1,
			x: 940,
			y: 464
		}, {
			pin: 2,
			x: 940,
			y: 473
		}],
		options: [{
			closed: !0,
			pins: [1, 2]
		}],
		toggle: !0,
		slider: {
			orientation: "vertical",
			track: {
				x: 936,
				y: 461,
				width: 8,
				height: 16
			},
			knob: {
				width: 10,
				height: 7
			},
			off: {
				x: 940,
				y: 474
			},
			on: {
				x: 940,
				y: 465
			}
		}
	},
	{
		designator: "J2",
		hit: {
			x: 558,
			y: 136,
			width: 76,
			height: 33
		},
		socket: {
			x: 578,
			y: 154,
			width: 36,
			height: 15
		},
		pins: [
			{
				pin: 2,
				x: 582,
				y: 158
			},
			{
				pin: 4,
				x: 594,
				y: 158
			},
			{
				pin: 6,
				x: 606,
				y: 158
			}
		],
		options: [{
			closed: !1,
			pins: [2, 4]
		}, {
			closed: !0,
			pins: [4, 6]
		}],
		toggle: !1,
		slider: {
			orientation: "horizontal",
			track: {
				x: 579,
				y: 154,
				width: 34,
				height: 10
			},
			knob: {
				width: 12,
				height: 10
			},
			off: {
				x: 588,
				y: 159
			},
			on: {
				x: 600,
				y: 159
			}
		}
	},
	{
		designator: "J2Tx",
		hit: {
			x: 558,
			y: 169,
			width: 76,
			height: 31
		},
		socket: {
			x: 578,
			y: 169,
			width: 36,
			height: 17
		},
		pins: [
			{
				pin: 1,
				x: 582,
				y: 181
			},
			{
				pin: 3,
				x: 594,
				y: 181
			},
			{
				pin: 5,
				x: 606,
				y: 181
			}
		],
		options: [{
			closed: !1,
			pins: [1, 3]
		}, {
			closed: !0,
			pins: [3, 5]
		}],
		toggle: !1,
		slider: {
			orientation: "horizontal",
			track: {
				x: 579,
				y: 176,
				width: 34,
				height: 10
			},
			knob: {
				width: 12,
				height: 10
			},
			off: {
				x: 588,
				y: 181
			},
			on: {
				x: 600,
				y: 181
			}
		}
	},
	{
		designator: "J6",
		hit: {
			x: 646,
			y: 418,
			width: 54,
			height: 32
		},
		socket: {
			x: 652,
			y: 422,
			width: 43,
			height: 16
		},
		pins: [
			{
				pin: 1,
				x: 661,
				y: 430
			},
			{
				pin: 2,
				x: 672,
				y: 430
			},
			{
				pin: 3,
				x: 683,
				y: 430
			}
		],
		options: [{
			closed: !1,
			pins: [1, 2]
		}, {
			closed: !0,
			pins: [2, 3]
		}],
		toggle: !1,
		slider: {
			orientation: "horizontal",
			track: {
				x: 654,
				y: 425,
				width: 39,
				height: 9
			},
			knob: {
				width: 14,
				height: 10
			},
			off: {
				x: 662,
				y: 429.5
			},
			on: {
				x: 684,
				y: 429.5
			}
		}
	}
], m = [
	{
		designator: "RB2",
		x: 733,
		y: 518,
		width: 49,
		height: 43
	},
	{
		designator: "RB4",
		x: 801,
		y: 518,
		width: 52,
		height: 43
	},
	{
		designator: "RB3",
		x: 869,
		y: 518,
		width: 53,
		height: 43
	}
];
function h(e) {
	return m.find((t) => _(t, e));
}
function g(e) {
	let t = e.x + (e.width - 136) / 2, n = {
		x: Math.min(t, 788),
		y: 590,
		width: 136,
		height: 54
	}, r = {
		x: n.x + 8,
		y: n.y + 28,
		width: 120,
		height: 16
	};
	return {
		designator: e.designator,
		panel: n,
		track: r
	};
}
function ee(e, t) {
	let n = (t - e.track.x) / e.track.width;
	return Math.round(Math.min(1, Math.max(0, n)) * 1e3) / 1e3;
}
function te(e, t) {
	let { track: n } = e;
	return {
		x: n.x + t * n.width - 6,
		y: n.y + (n.height - 20) / 2,
		width: 12,
		height: 20
	};
}
function _(e, t) {
	return t.x >= e.x && t.y >= e.y && t.x <= e.x + e.width && t.y <= e.y + e.height;
}
function v(e) {
	return c.find((t) => _(t, e));
}
function ne(e) {
	let t = c.find((t) => t.designator === e);
	if (t === void 0) throw Error(`Unknown CT107D key: ${e}`);
	return t;
}
function y(e) {
	return p.find((t) => _(t.hit, e));
}
function b(e, t) {
	let n = e.pins.find((e) => e.pin === t);
	if (n === void 0) throw Error(`${e.designator} has no pin ${t}`);
	return {
		x: n.x,
		y: n.y
	};
}
function x(e, t) {
	let n = b(e, t.pins[0]), r = b(e, t.pins[1]);
	return {
		x: (n.x + r.x) / 2,
		y: (n.y + r.y) / 2
	};
}
function S(e, t) {
	let { knob: n, off: r, on: i } = e.slider, a = t ? i : r;
	return {
		x: a.x - n.width / 2,
		y: a.y - n.height / 2,
		width: n.width,
		height: n.height
	};
}
function C(e, t) {
	let n, r = Infinity;
	for (let i of e.options) {
		let a = x(e, i), o = Math.hypot(a.x - t.x, a.y - t.y);
		o < r && (n = i, r = o);
	}
	return n;
}
function re(e) {
	let t = y(e);
	if (t === void 0) return;
	if (t.toggle) return { designator: t.designator };
	let n = C(t, e);
	return n === void 0 ? void 0 : {
		designator: t.designator,
		closed: n.closed
	};
}
var w = [
	"J13",
	"J3",
	"J2",
	"J5",
	"J2Tx",
	"J6"
];
function T(e) {
	return e === "J2Tx" ? {
		designator: "J2",
		port: "closedState1"
	} : {
		designator: e,
		port: e === "J2" ? "closedState2" : "closedState"
	};
}
function E(e, t) {
	if (t.startsWith("closedState")) return w.find((n) => {
		let r = T(n);
		return r.designator === e && r.port === t;
	});
}
function ie(e, t) {
	return e === "J2Tx" ? {
		designator: "J2",
		channel: 1,
		closed: t
	} : {
		designator: e,
		closed: t
	};
}
var D = {
	J13: !0,
	J3: !0,
	J2: !0,
	J2Tx: !1,
	J5: !0,
	J6: !0
}, O = [
	"RB2",
	"RB4",
	"RB3"
], k = .5, A = [
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
], j = ["DS1", "DS2"], ae = new Set(A), oe = new Set(j), se = new Set(O), ce = /^D([1-8])$/, le = /^digit([1-4])$/;
function ue() {
	let e = de(), t = 0, n = /* @__PURE__ */ new Map();
	function r(e) {
		t += 1, n.set(e, t);
	}
	function i(e, t) {
		return (n.get(e) ?? 0) <= t;
	}
	return {
		state: e,
		beginSnapshot: () => t,
		applySnapshot(t, n) {
			let r = !1;
			for (let a of j) {
				let o = t.displays[a];
				for (let t = 0; t < 4; t += 1) {
					if (!i(M(a, t), n)) continue;
					let s = I(o[t] ?? 0);
					e.displays[a][t] !== s && (e.displays[a][t] = s, r = !0);
				}
			}
			for (let a = 0; a < e.leds.length; a += 1) {
				if (!i(N(a), n)) continue;
				let o = L(t.leds[a] ?? 0);
				e.leds[a] !== o && (e.leds[a] = o, r = !0);
			}
			i("actuator:relay", n) && e.relay !== t.relay && (e.relay = t.relay, r = !0), i("actuator:buzzer", n) && e.buzzer !== t.buzzer && (e.buzzer = t.buzzer, r = !0);
			for (let a of A) {
				if (!i(P(a), n)) continue;
				let o = t.switches[a];
				e.switches[a] !== o && (e.switches[a] = o, r = !0);
			}
			for (let a of w) {
				if (!i(F(a), n)) continue;
				let o = t.jumpers[a];
				e.jumpers[a] !== o && (e.jumpers[a] = o, r = !0);
			}
			for (let a of O) {
				if (!i(`potentiometer:${a}`, n)) continue;
				let o = L(t.potentiometers[a]);
				e.potentiometers[a] !== o && (e.potentiometers[a] = o, r = !0);
			}
			return r;
		},
		applySignal(t) {
			if (!Number.isFinite(t.value)) return !1;
			if (t.port === "position" && se.has(t.designator)) {
				let n = t.designator, i = L(t.value);
				return r(`potentiometer:${n}`), e.potentiometers[n] !== i && (e.potentiometers[n] = i, !0);
			}
			if (oe.has(t.designator)) {
				let n = t.designator, i = le.exec(t.port);
				if (i === null) return !1;
				let a = Number.parseInt(i[1], 10) - 1, o = I(t.value);
				return r(M(n, a)), e.displays[n][a] !== o && (e.displays[n][a] = o, !0);
			}
			let n = ce.exec(t.designator);
			if (n !== null) {
				if (t.port !== "brightness") return !1;
				let i = Number.parseInt(n[1], 10) - 1, a = L(t.value);
				return r(N(i)), e.leds[i] !== a && (e.leds[i] = a, !0);
			}
			if (t.designator === "K1" && t.port === "energized") {
				let n = t.value !== 0;
				return r("actuator:relay"), e.relay !== n && (e.relay = n, !0);
			}
			if (t.designator === "SP1" && t.port === "active") {
				let n = t.value !== 0;
				return r("actuator:buzzer"), e.buzzer !== n && (e.buzzer = n, !0);
			}
			if (ae.has(t.designator)) {
				if (t.port !== "press" && t.port !== "pressed") return !1;
				let n = t.designator, i = t.value !== 0;
				return r(P(n)), e.switches[n] !== i && (e.switches[n] = i, !0);
			}
			let i = E(t.designator, t.port);
			if (i !== void 0) {
				let n = t.value !== 0;
				return r(F(i)), e.jumpers[i] !== n && (e.jumpers[i] = n, !0);
			}
			return !1;
		}
	};
}
function de() {
	return {
		displays: {
			DS1: [
				0,
				0,
				0,
				0
			],
			DS2: [
				0,
				0,
				0,
				0
			]
		},
		leds: Array.from({ length: 8 }, () => 0),
		relay: !1,
		buzzer: !1,
		switches: {
			S1: !1,
			S4: !1,
			S5: !1,
			S6: !1,
			S7: !1,
			S8: !1,
			S9: !1,
			S10: !1,
			S11: !1,
			S12: !1,
			S13: !1,
			S14: !1,
			S15: !1,
			S16: !1,
			S17: !1,
			S18: !1,
			S19: !1
		},
		jumpers: { ...D },
		potentiometers: {
			RB2: 0,
			RB3: k,
			RB4: 0
		}
	};
}
function M(e, t) {
	return `display:${e}:${t}`;
}
function N(e) {
	return `led:${e}`;
}
function P(e) {
	return `switch:${e}`;
}
function F(e) {
	return `jumper:${e}`;
}
function I(e) {
	return Math.min(255, Math.max(0, Math.trunc(e)));
}
function L(e) {
	return Math.min(1, Math.max(0, e));
}
function fe(e) {
	if (typeof e != "object" || !e) return;
	let t = e, n = t.designator, r = t.port, i = t.value;
	if (typeof n == "string" && typeof r == "string" && typeof i == "number" && Number.isFinite(i)) return {
		designator: n,
		port: r,
		value: i
	};
}
function pe(e) {
	let t = R(e, "CT107D snapshot"), n = R(t.displays, "CT107D snapshot.displays"), r = R(t.switches, "CT107D snapshot.switches"), i = R(t.jumpers, "CT107D snapshot.jumpers"), a = B(R(t.pcf8591, "CT107D snapshot.pcf8591").analog, "CT107D snapshot.pcf8591.analog", 4), o = R(t.ne555, "CT107D snapshot.ne555"), s = R(t.amplifier, "CT107D snapshot.amplifier");
	return {
		displays: {
			DS1: B(n.DS1, "CT107D snapshot.displays.DS1", 4),
			DS2: B(n.DS2, "CT107D snapshot.displays.DS2", 4)
		},
		leds: B(t.leds, "CT107D snapshot.leds", 8),
		relay: z(t.relay, "CT107D snapshot.relay"),
		buzzer: z(t.buzzer, "CT107D snapshot.buzzer"),
		switches: {
			S1: z(r.S1, "CT107D snapshot.switches.S1"),
			S4: z(r.S4, "CT107D snapshot.switches.S4"),
			S5: z(r.S5, "CT107D snapshot.switches.S5"),
			S6: z(r.S6, "CT107D snapshot.switches.S6"),
			S7: z(r.S7, "CT107D snapshot.switches.S7"),
			S8: z(r.S8, "CT107D snapshot.switches.S8"),
			S9: z(r.S9, "CT107D snapshot.switches.S9"),
			S10: z(r.S10, "CT107D snapshot.switches.S10"),
			S11: z(r.S11, "CT107D snapshot.switches.S11"),
			S12: z(r.S12, "CT107D snapshot.switches.S12"),
			S13: z(r.S13, "CT107D snapshot.switches.S13"),
			S14: z(r.S14, "CT107D snapshot.switches.S14"),
			S15: z(r.S15, "CT107D snapshot.switches.S15"),
			S16: z(r.S16, "CT107D snapshot.switches.S16"),
			S17: z(r.S17, "CT107D snapshot.switches.S17"),
			S18: z(r.S18, "CT107D snapshot.switches.S18"),
			S19: z(r.S19, "CT107D snapshot.switches.S19")
		},
		jumpers: Object.fromEntries(w.map((e) => [e, z(i[e], `CT107D snapshot.jumpers.${e}`)])),
		potentiometers: {
			RB2: a[3],
			RB3: V(o.position, "CT107D snapshot.ne555.position"),
			RB4: V(s.position, "CT107D snapshot.amplifier.position")
		}
	};
}
function R(e, t) {
	if (typeof e != "object" || !e || Array.isArray(e)) throw TypeError(`${t} must be an object.`);
	return e;
}
function z(e, t) {
	if (typeof e != "boolean") throw TypeError(`${t} must be a boolean.`);
	return e;
}
function B(e, t, n) {
	if (!Array.isArray(e) || e.length < n) throw TypeError(`${t} must contain at least ${n} numbers.`);
	return e.map((e, n) => V(e, `${t}[${n}]`));
}
function V(e, t) {
	if (typeof e != "number" || !Number.isFinite(e)) throw TypeError(`${t} must be a finite number.`);
	return e;
}
// src/view2d.ts
var H = "rgba(255, 59, 48, 0.94)", U = "rgba(124, 32, 27, 0.24)", W = "rgba(49, 210, 192, 1)", G = "rgba(49, 210, 192, 0.55)", K = "rgba(234, 183, 96, 0.96)", me = "#151a19", q = "#454c49", he = "#7f8f99", J = "#c9ceca", ge = "#d2d6d2", Y = .58;
function X(t) {
	let n = ue(), i = {
		hoveredKey: void 0,
		hoveredJumper: void 0,
		openPotentiometer: void 0,
		pointerKey: void 0
	}, o, s = !1, c = !1, l = t.model === void 0 ? void 0 : t.audio?.tone({
		frequency: 2e3,
		type: "square",
		volume: 0
	}), u = !1, d = t.model?.events.onDidSignal, f = d === void 0 ? void 0 : d((e) => {
		if (s) return;
		let t = fe(e.value);
		t !== void 0 && n.applySignal(t) && (m(), p());
	});
	function p() {
		s || t.invalidate();
	}
	function m() {
		let e = n.state.buzzer;
		l !== void 0 && e !== u && (u = e, l.set({ volume: e ? .06 : 0 }, { rampMs: 5 }));
	}
	function b(e, n) {
		let r = t.model;
		if (r === void 0) return Promise.resolve(null);
		let i = r.methods[e];
		if (i === void 0) throw Error(`CT107D model method "${e}" is not declared.`);
		return i(n);
	}
	function x(e) {
		i.pointerKey === e && (i.pointerKey = void 0, p());
	}
	function S(e) {
		let t = v(e)?.designator, n = t === void 0 ? y(e)?.designator : void 0;
		(i.hoveredKey !== t || i.hoveredJumper !== n) && (i.hoveredKey = t, i.hoveredJumper = n, p());
	}
	function C() {
		let e = i.pointerKey;
		if (e !== void 0 && (i.pointerKey = void 0, p(), t.model !== void 0)) return b("setSwitch", {
			designator: e,
			pressed: !1
		}).then(() => void 0);
	}
	function w(e) {
		if (t.model === void 0) return;
		i.pointerKey = e, i.hoveredKey = e, i.hoveredJumper = void 0, p();
		let n;
		try {
			n = b("setSwitch", {
				designator: e,
				pressed: !0
			});
		} catch (t) {
			throw x(e), t;
		}
		return n.then(() => void 0, (t) => {
			throw x(e), t;
		});
	}
	function T(e, t) {
		let n = ee(e.slider, t.x);
		if (e.lastRequested === n) return;
		e.lastRequested = n;
		let r = e.slider.designator;
		return b(r === "RB2" ? "setAnalogInput" : r === "RB3" ? "setFrequencyWiper" : "setWiper", r === "RB2" ? {
			channel: 3,
			value: n
		} : { value: n }).then(() => void 0);
	}
	function E(e) {
		if (e.button !== 0 || (S(e.position), i.pointerKey !== void 0 || o !== void 0)) return;
		let r = i.openPotentiometer;
		if (r !== void 0 && _(r.panel, e.position)) {
			let t = n.state.potentiometers[r.designator], i = _(r.track, e.position), a = _(te(r, t), e.position);
			return !i && !a ? void 0 : (o = {
				slider: r,
				lastRequested: t
			}, a ? void 0 : T(o, e.position));
		}
		let a = h(e.position);
		if (a !== void 0 && t.model !== void 0) {
			i.openPotentiometer = r?.designator === a.designator ? void 0 : g(a), p();
			return;
		}
		r !== void 0 && (i.openPotentiometer = void 0, p());
		let s = re(e.position);
		if (s !== void 0) {
			let e = s.closed ?? !n.state.jumpers[s.designator];
			return b("setJumper", ie(s.designator, e)).then(() => void 0);
		}
		let c = v(e.position);
		if (c !== void 0) return w(c.designator);
	}
	function D(e) {
		if (S(e.position), o !== void 0) {
			if (e.buttons & 1) return T(o, e.position);
			o = void 0;
		}
		let t = i.pointerKey;
		if (t !== void 0 && !_(ne(t), e.position)) return C();
	}
	function O(e) {
		return S(e.position), o = void 0, C();
	}
	function k(e, t) {
		console.error(`CT107D View2D: releasing ${e} during dispose failed.`, t);
	}
	function A(e) {
		let n = t.model;
		if (n === void 0) return;
		let r = n.methods.setSwitch;
		if (r !== void 0) try {
			r({
				designator: e,
				pressed: !1
			}).catch((t) => {
				k(e, t);
			});
		} catch (t) {
			k(e, t);
		}
	}
	return {
		async initialize() {
			if (s || c) return;
			if (c = !0, t.model === void 0) {
				p();
				return;
			}
			let e = n.beginSnapshot(), r;
			try {
				r = await b("getSnapshot", null);
			} catch (e) {
				if (s) return;
				throw e;
			}
			if (s) return;
			let i = pe(r);
			n.applySnapshot(i, e), m(), p();
		},
		renderOverlay(t) {
			if (!s) {
				t.save();
				try {
					t.scale(r, r), t.translate(-e.x, -e.y), Q(t, n.state, i);
				} finally {
					t.restore();
				}
			}
		},
		input(e) {
			if (s) return;
			let t = {
				...e,
				position: a(e.position)
			};
			switch (t.type) {
				case "pointerdown": return E(t);
				case "pointermove": return D(t);
				case "pointerup": return O(t);
				case "pointercancel":
				case "pointerleave": return o = void 0, i.hoveredKey = void 0, i.hoveredJumper = void 0, p(), C();
				default: return;
			}
		},
		dispose() {
			if (s) return;
			let e = i.pointerKey;
			s = !0, f?.dispose(), l?.stop(), o = void 0, i.openPotentiometer = void 0, i.pointerKey = void 0, i.hoveredKey = void 0, i.hoveredJumper = void 0, e !== void 0 && A(e);
		}
	};
}
var Z = (e) => X(e);
function Q(e, t, n) {
	e.save();
	try {
		for (let n of l) ve(e, n, t.displays[n.designator]);
		Se(e, t), Ce(e, t);
		for (let r of p) we(e, r, t.jumpers[r.designator], n);
		_e(e, t, n);
		let r = n.openPotentiometer;
		r !== void 0 && Ee(e, r, t.potentiometers[r.designator]);
	} finally {
		e.restore();
	}
}
function _e(e, t, n) {
	for (let r of c) {
		let i = t.switches[r.designator] || n.pointerKey === r.designator, a = n.hoveredKey === r.designator;
		(i || a) && (e.beginPath(), e.arc(r.x + r.width / 2, r.y + r.height / 2, 11.5, 0, Math.PI * 2), i && (e.fillStyle = "rgba(49, 210, 192, 0.18)", e.fill()), e.strokeStyle = i ? W : G, e.lineWidth = i ? 1.8 : 1.1, e.stroke());
	}
}
function ve(e, t, n) {
	let r = t.width / 4, i = r * .78, a = Math.min(t.height * .82, i / Y), o = a * Y, s = Math.max(1.4, a * .13), c = Math.max(1.8, a * .09), l = t.y + (t.height - a) / 2;
	for (let i = 0; i < 4; i += 1) ye(e, {
		left: t.x + i * r + (r - o) / 2,
		top: l,
		width: o,
		height: a
	}, s, n[i] ?? 0, c);
}
function ye(e, t, n, r, i) {
	let { left: a, top: o, width: s, height: c } = t, l = n / 2, u = n * .22, d = a + s, f = o + c, p = o + c / 2, m = a + l + u, h = d - l - u, g = [
		{
			bit: 0,
			axis: "x",
			from: m,
			to: h,
			at: o + l
		},
		{
			bit: 6,
			axis: "x",
			from: m,
			to: h,
			at: p
		},
		{
			bit: 3,
			axis: "x",
			from: m,
			to: h,
			at: f - l
		},
		{
			bit: 5,
			axis: "y",
			from: o + l + u,
			to: p - u,
			at: a + l
		},
		{
			bit: 1,
			axis: "y",
			from: o + l + u,
			to: p - u,
			at: d - l
		},
		{
			bit: 4,
			axis: "y",
			from: p + u,
			to: f - l - u,
			at: a + l
		},
		{
			bit: 2,
			axis: "y",
			from: p + u,
			to: f - l - u,
			at: d - l
		}
	];
	for (let t of g) t.to > t.from && (e.fillStyle = r & 1 << t.bit ? H : U, t.axis === "x" ? be(e, t.from, t.to, t.at, n) : xe(e, t.at, t.from, t.to, n), e.fill());
	e.fillStyle = r & 128 ? H : U, e.beginPath(), e.roundRect(d - i, f - i, i, i, i * .25), e.fill();
}
function be(e, t, n, r, i) {
	let a = i / 2;
	e.beginPath(), e.moveTo(t, r), e.lineTo(t + a, r - a), e.lineTo(n - a, r - a), e.lineTo(n, r), e.lineTo(n - a, r + a), e.lineTo(t + a, r + a), e.closePath();
}
function xe(e, t, n, r, i) {
	let a = i / 2;
	e.beginPath(), e.moveTo(t, n), e.lineTo(t + a, n + a), e.lineTo(t + a, r - a), e.lineTo(t, r), e.lineTo(t - a, r - a), e.lineTo(t - a, n + a), e.closePath();
}
function Se(e, t) {
	for (let n = 0; n < u.length; n += 1) {
		let r = t.leds[n] ?? 0;
		if (r <= 0) continue;
		let i = u[n], a = r ** .42, o = 8 + 6 * a, s = e.createRadialGradient(i.x, i.y, 0, i.x, i.y, o);
		s.addColorStop(0, `rgba(255, 72, 52, ${.95 * a})`), s.addColorStop(.5, `rgba(255, 59, 48, ${.58 * a})`), s.addColorStop(1, "rgba(255, 59, 48, 0)"), e.fillStyle = s, e.beginPath(), e.arc(i.x, i.y, o, 0, Math.PI * 2), e.fill(), e.fillStyle = `rgba(255, 62, 41, ${Math.min(1, 1.25 * a)})`, e.beginPath(), e.ellipse(i.x, i.y, 4.4, 6.5, 0, 0, Math.PI * 2), e.fill(), e.fillStyle = `rgba(255, 239, 196, ${.98 * a})`, e.beginPath(), e.ellipse(i.x, i.y, 2.7, 4.6, 0, 0, Math.PI * 2), e.fill();
	}
}
function Ce(e, t) {
	if (t.buzzer) {
		let t = d.x + d.width / 2, n = d.y + d.height / 2;
		e.strokeStyle = K, e.lineWidth = 1.8, e.beginPath(), e.arc(t, n, 23, 0, Math.PI * 2), e.stroke(), e.lineWidth = 1.4;
		for (let r of [30, 37]) e.beginPath(), e.arc(t, n, r, -.55, .55), e.stroke();
	}
	if (t.relay) {
		let t = Oe(f, 4);
		e.beginPath(), e.roundRect(t.x, t.y, t.width, t.height, 6), e.strokeStyle = K, e.lineWidth = 1.8, e.stroke(), e.fillStyle = K, e.beginPath(), e.arc(t.x + t.width - 7, t.y + 7, 2.3, 0, Math.PI * 2), e.fill();
	}
}
function we(e, t, n, r) {
	let { x: i, y: a, width: o, height: s } = t.socket;
	if (e.fillStyle = "#26312f", e.fillRect(i, a, o, s), $(e, t.slider.track), Te(e, t, n), r.hoveredJumper === t.designator) {
		let n = t.slider.track;
		e.beginPath(), e.roundRect(n.x - 2, n.y - 2, n.width + 4, n.height + 4, 4), e.strokeStyle = G, e.lineWidth = 1.2, e.stroke();
	}
}
function $(e, t) {
	let n = Math.min(t.width, t.height) / 2;
	e.beginPath(), e.roundRect(t.x, t.y, t.width, t.height, n), e.fillStyle = me, e.fill(), e.strokeStyle = q, e.lineWidth = 1, e.stroke();
}
function Te(e, t, n) {
	De(e, S(t, n), t.slider.orientation);
}
function Ee(e, t, n) {
	let { panel: r, track: i } = t;
	e.beginPath(), e.roundRect(r.x, r.y, r.width, r.height, 6), e.fillStyle = "#101615", e.fill(), e.strokeStyle = q, e.lineWidth = 1, e.stroke(), $(e, i);
	let a = te(t, n), o = Math.min(i.width - 6, a.x + a.width / 2 - i.x - 3);
	o > 0 && (e.beginPath(), e.roundRect(i.x + 3, i.y + 4, o, 8, 3), e.fillStyle = G, e.fill()), De(e, a, "horizontal"), e.font = "600 11px system-ui, sans-serif", e.textBaseline = "middle", e.textAlign = "left", e.fillStyle = W, e.fillText(t.designator, r.x + 8, r.y + 16), e.textAlign = "right", e.fillStyle = J, e.fillText(`${Math.round(n * 100)}%`, r.x + r.width - 8, r.y + 16);
}
function De(e, t, n) {
	let r = Math.max(2, Math.min(t.width, t.height) * .28);
	e.beginPath(), e.roundRect(t.x, t.y, t.width, t.height, r), e.fillStyle = he, e.fill(), e.strokeStyle = J, e.lineWidth = 1, e.stroke();
	let i = t.x + t.width / 2, a = t.y + t.height / 2, o = Math.min(t.width, t.height), s = Math.max(1.5, o * .3);
	e.beginPath(), n === "horizontal" ? (e.moveTo(i, a - s), e.lineTo(i, a + s)) : (e.moveTo(i - s, a), e.lineTo(i + s, a)), e.strokeStyle = ge, e.lineWidth = Math.max(1.2, o * .16), e.lineCap = "round", e.stroke();
}
function Oe(e, t) {
	return {
		x: e.x + t,
		y: e.y + t,
		width: Math.max(0, e.width - t * 2),
		height: Math.max(0, e.height - t * 2)
	};
}
export { X as createBoardView, Z as createView, Z as default, Q as drawBoard };
