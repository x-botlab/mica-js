// src/presentation.ts
var e = {
	x: 31,
	y: 24
}, t = {
	width: 941,
	height: 712
};
t.width / 10, t.height / 10;
var n = 1 / 10;
function r(t) {
	return {
		x: t.x * 10 + e.x,
		y: t.y * 10 + e.y
	};
}
var i = Object.freeze({
	x: 220,
	y: 90,
	width: 491,
	height: 398,
	radius: 5
}), a = 320, o = 240, s = 8;
function c(e, t = !1) {
	if (!(e instanceof Uint8Array) || e.byteLength < s) return;
	let n = new DataView(e.buffer, e.byteOffset, e.byteLength), r = t ? 0 : n.getUint16(0, !0), i = t ? 0 : n.getUint16(2, !0), c = n.getUint16(4, !0), l = n.getUint16(6, !0);
	if (!(c === 0 || l === 0 || r + c > a || i + l > o || t && (c !== a || l !== o) || e.byteLength !== s + c * l * 2)) return {
		bytes: n,
		x: r,
		y: i,
		width: c,
		height: l
	};
}
function l() {
	let e = new OffscreenCanvas(a, o), t = e.getContext("2d", { alpha: !1 });
	if (!t) throw Error("CT117E-M4: no 2D canvas for the LCD.");
	return {
		apply({ bytes: e, x: n, y: r, width: i, height: a }) {
			let o = t.createImageData(i, a), c = o.data;
			for (let t = 0; t < i * a; t += 1) {
				let n = e.getUint16(s + t * 2, !0), r = n >>> 11 & 31, i = n >>> 5 & 63, a = n & 31;
				c[t * 4] = r << 3 | r >>> 2, c[t * 4 + 1] = i << 2 | i >>> 4, c[t * 4 + 2] = a << 3 | a >>> 2, c[t * 4 + 3] = 255;
			}
			t.putImageData(o, n, r);
		},
		draw(t) {
			t.save(), t.beginPath(), t.roundRect(i.x, i.y, i.width, i.height, i.radius), t.clip(), t.imageSmoothingEnabled = !1, t.drawImage(e, i.x, i.y, i.width, i.height), t.restore();
		}
	};
}
// src/view2d.ts
var u = [
	429,
	485,
	542,
	599
].map((e, t) => ({
	x: 90,
	y: e,
	id: t + 1
})), d = [
	327,
	300,
	273,
	246,
	219,
	192,
	165,
	138
], f = [
	{
		x: 424,
		label: "R37",
		method: "setPotentiometer",
		id: 1
	},
	{
		x: 531,
		label: "R38",
		method: "setPotentiometer",
		id: 2
	},
	{
		x: 640,
		label: "R39",
		method: "setTimerPotentiometer",
		id: 1
	},
	{
		x: 749,
		label: "R40",
		method: "setTimerPotentiometer",
		id: 2
	}
], p = "#67e8da", m = 608, h = 65;
function g({ x: e, y: t }) {
	return u.find((n) => Math.abs(e - n.x) <= 29 && Math.abs(t - n.y) <= 19);
}
function _({ model: t, invalidate: i }) {
	let a, o, s = 0, u = 0, _ = !1, y = !1, b, x, S = new Map(f.map((e) => [e, {
		position: .5,
		applied: 0
	}])), C = 0;
	function w(e, n) {
		let r = t?.methods[e];
		if (!r) throw Error(`CT117E-M4: missing model method ${e}.`);
		return r(n);
	}
	function T(e) {
		typeof e != "number" || !Number.isInteger(e) || e < 0 || e > 255 || (u += 1, e !== s && (s = e, i()));
	}
	function E(e) {
		(a ??= l()).apply(e);
	}
	let D = t?.events.onDidLed?.(({ value: e }) => {
		_ || T(e);
	}), O = t?.events.onDidFramebuffer?.(({ value: e }) => {
		if (_) return;
		let t = c(e);
		t && (o ? o.push(t) : (E(t), i()));
	});
	async function k() {
		let e = b;
		b = void 0, e?.kind === "button" && (_ || i(), await w("setButton", {
			id: e.button.id,
			pressed: !1
		}));
	}
	async function A(e, t) {
		let { pot: n } = e, r = Math.max(0, Math.min(1, (t - n.x + h) / 130));
		if (r === e.requested) return;
		e.requested = r;
		let a = ++C;
		try {
			await w(n.method, {
				id: n.id,
				position: r
			});
		} catch (t) {
			throw e.requested === r && (e.requested = NaN), t;
		}
		let o = S.get(n);
		_ || a < o.applied || (o.applied = a, o.position = r, i());
	}
	return {
		async initialize() {
			if (_ || y || !t) return;
			y = !0;
			let e = u;
			o = [];
			try {
				let [t, n] = await Promise.all([w("getFramebuffer", null), w("getLedState", null)]);
				if (_) return;
				let r = c(t, !0);
				if (!r) throw Error("CT117E-M4: invalid framebuffer snapshot.");
				E(r);
				for (let e of o) E(e);
				u === e && T(n), i();
			} finally {
				o = void 0;
			}
		},
		renderOverlay(r) {
			if (!_ && t) {
				r.save();
				try {
					r.scale(n, n), r.translate(-e.x, -e.y), a?.draw(r);
					for (let [e, t] of d.entries()) s & 1 << e && (r.fillStyle = "#fff6a1", r.shadowColor = "#ffce45", r.shadowBlur = 7, r.beginPath(), r.roundRect(t - 4, 669, 8, 16, 2), r.fill());
					if (r.shadowBlur = 0, b?.kind === "button") {
						let { x: e, y: t } = b.button;
						r.fillStyle = "rgba(103, 232, 218, 0.45)", r.strokeStyle = p, r.lineWidth = 2, r.beginPath(), r.roundRect(e - 15, t - 10, 30, 20, 3), r.fill(), r.stroke();
					}
					x && v(r, x, S.get(x).position);
				} finally {
					r.restore();
				}
			}
		},
		async input(e) {
			if (_ || !t) return;
			let { type: n, position: a, button: o, buttons: s } = {
				...e,
				position: r(e.position)
			};
			if (n === "pointercancel" || n === "pointerleave" || n === "pointerup" && o === 0) return k();
			if (n === "pointermove") return b ? s & 1 ? b.kind === "slider" ? A(b, a.x) : g(a) === b.button ? void 0 : k() : k() : void 0;
			if (n !== "pointerdown" || o !== 0 || b) return;
			let { x: c, y: l } = a;
			if (x && Math.abs(c - x.x) <= 78 && l >= 571 && l <= 621) return Math.abs(l - m) <= 10 && Math.abs(c - x.x) <= 71 ? (b = {
				kind: "slider",
				pot: x,
				requested: S.get(x).position
			}, A(b, c)) : void 0;
			let u = f.find((e) => Math.abs(c - e.x) <= 43 && l >= 644 && l <= 734), d = u === x ? void 0 : u;
			d !== x && (x = d, i());
			let p = g(a);
			if (!p) return;
			let h = {
				kind: "button",
				button: p
			};
			b = h, i();
			try {
				await w("setButton", {
					id: p.id,
					pressed: !0
				});
			} catch (e) {
				throw b === h && (b = void 0, i()), e;
			}
		},
		dispose() {
			_ || (_ = !0, D?.dispose(), O?.dispose(), a = void 0, o = void 0, k().catch((e) => {
				console.error("CT117E-M4 View2D: failed to release held button.", e);
			}));
		}
	};
}
function v(e, t, n) {
	let { x: r, label: i } = t;
	e.beginPath(), e.roundRect(r - 78, 571, 156, 50, 6), e.fillStyle = "#12181d", e.fill(), e.strokeStyle = "#5b6972", e.lineWidth = 1, e.stroke(), e.font = "600 13px system-ui, sans-serif", e.textBaseline = "middle", e.textAlign = "left", e.fillStyle = p, e.fillText(i, r - h, 585), e.textAlign = "right", e.fillStyle = "#e6edf1", e.fillText(`${Math.round(n * 100)}%`, r + h, 585);
	let a = r - h, o = 130 * n;
	e.fillStyle = "#47545e", e.fillRect(a, 606, 130, 4), e.fillStyle = p, e.fillRect(a, 606, o, 4), e.beginPath(), e.arc(a + o, m, 6, 0, Math.PI * 2), e.fill();
}
var y = _;
export { _ as createBoardView, y as default };
