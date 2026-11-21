// ../../node_modules/.pnpm/@mica-js+device-model@0.7.0/node_modules/@mica-js/device-model/dist/index.js
function e(e) {
	return t(e, /* @__PURE__ */ new Set(), []);
}
function t(e, n, i) {
	if (typeof e != "object" || !e) return (typeof e == "function" || typeof e == "symbol" || typeof e == "bigint") && r("IR_SCHEMA", "Expected ordinary IR data.", i.slice()), e;
	n.has(e) && r("IR_SCHEMA", "Cyclic IR data is not supported.", i.slice()), n.add(e);
	let a;
	if (e instanceof Uint8Array) a = Object.freeze(Array.from(Uint8Array.prototype.values.call(e)));
	else if (Array.isArray(e)) {
		Object.getPrototypeOf(e) !== Array.prototype && r("IR_SCHEMA", "Expected an ordinary IR array.");
		let o = [];
		for (let t of Reflect.ownKeys(e)) t !== "length" && ((typeof t != "string" || !/^(0|[1-9][0-9]*)$/.test(t) || Number(t) >= e.length) && r("IR_SCHEMA", "IR arrays cannot contain extra properties."), "value" in Object.getOwnPropertyDescriptor(e, t) || r("IR_SCHEMA", "IR arrays cannot contain accessors."));
		for (let a = 0; a < e.length; a++) Object.hasOwn(e, a) || r("IR_SCHEMA", "IR arrays cannot be sparse."), i.push(a), o.push(t(Object.getOwnPropertyDescriptor(e, a).value, n, i)), i.pop();
		a = Object.freeze(o);
	} else {
		let o = Object.getPrototypeOf(e);
		o !== Object.prototype && o !== null && r("IR_SCHEMA", "Expected an ordinary data object.");
		let s = {};
		for (let a of Reflect.ownKeys(e)) {
			let o = Object.getOwnPropertyDescriptor(e, a);
			typeof a == "string" && "value" in o || r("IR_SCHEMA", "IR data cannot contain symbols or accessors."), i.push(a);
			let c = t(o.value, n, i);
			i.pop(), a === "__proto__" ? Object.defineProperty(s, a, {
				value: c,
				enumerable: !0
			}) : s[a] = c;
		}
		a = Object.freeze(s);
	}
	return n.delete(e), a;
}
var n = class extends Error {
	diagnostics;
	constructor(t) {
		if (!t.length) throw TypeError("BuildError requires at least one diagnostic.");
		super(t.map((e) => e.message).join("\n")), this.name = "BuildError", this.diagnostics = e(t);
	}
};
function r(e, t, r = [], i = "finalize", a) {
	throw new n([{
		code: e,
		message: t,
		path: r,
		phase: i,
		related: [],
		...a === void 0 ? {} : { source: a }
	}]);
}
var i = Object.freeze({
	Logic: [
		"low",
		"high",
		"unknown"
	],
	SampleStatus: ["valid", "floating"],
	Overflow: [
		"drop_new",
		"drop_oldest",
		"error"
	]
}), a = [
	"positive",
	"negate",
	"not",
	"bitNot"
], o = [
	"add",
	"subtract",
	"multiply",
	"divide",
	"remainder",
	"power",
	"lessThan",
	"lessThanOrEqual",
	"greaterThan",
	"greaterThanOrEqual",
	"equal",
	"notEqual",
	"concat",
	"bitAnd",
	"bitOr",
	"bitXor",
	"shiftLeft",
	"shiftRight",
	"shiftRightUnsigned"
], s = [
	"isNaN",
	"isFinite",
	"isInteger",
	"isSafeInteger",
	"abs",
	"floor",
	"ceil",
	"trunc",
	"round",
	"sqrt",
	"min",
	"max",
	"pow"
], c = [
	"load8",
	"load16le",
	"load16be",
	"load32le",
	"load32be"
], l = [
	"store8",
	"store16le",
	"store16be",
	"store32le",
	"store32be"
], u = [
	"number",
	"bool",
	"string",
	"bytes",
	"sample",
	"intent",
	"enum",
	"record"
];
function d(e, t) {
	(typeof e != "object" || !e || Array.isArray(e)) && r("IR_SCHEMA", "Expected a data object.", t);
}
function f(e, t, n, i, a = !0) {
	for (let n of t) Object.hasOwn(e, n) || r("IR_SCHEMA", `Missing field ${n}.`, [...i, n]);
	for (let o of Object.keys(e)) a && o === "source" || t.includes(o) || n.includes(o) || r("IR_SCHEMA", `Unexpected field ${o}.`, [...i, o]);
	Object.hasOwn(e, "source") && te(e.source, [...i, "source"]);
}
function p(e, t) {
	typeof e != "string" && r("IR_SCHEMA", "Expected a string.", t);
}
function m(e, t) {
	typeof e != "boolean" && r("IR_SCHEMA", "Expected a boolean.", t);
}
function ee(e, t) {
	typeof e != "number" && r("IR_SCHEMA", "Expected a number.", t);
}
function h(e, t) {
	(typeof e != "number" || !Number.isSafeInteger(e) || e < 0) && r("IR_SCHEMA", "Expected a nonnegative safe integer.", t);
}
function g(e, t, n) {
	t.includes(e) || r("IR_SCHEMA", `Expected one of ${t.join(", ")}.`, n);
}
function _(e, t, n) {
	Array.isArray(e) || r("IR_SCHEMA", "Expected an array.", t);
	for (let r = 0; r < e.length; r++) n(e[r], [...t, r]);
}
function te(e, t) {
	d(e, t);
	let n = Object.hasOwn(e, "uri");
	for (let n of Object.keys(e)) [
		"uri",
		"range",
		"label"
	].includes(n) || r("IR_SCHEMA", "Invalid source field.", [...t, n]);
	if (Object.hasOwn(e, "label") && p(e.label, [...t, "label"]), !n) {
		(!Object.hasOwn(e, "label") || Object.hasOwn(e, "range")) && r("IR_SCHEMA", "Source requires a label or URI and range.", t);
		return;
	}
	p(e.uri, [...t, "uri"]), d(e.range, [...t, "range"]);
	let i = e.range;
	for (let e of Object.keys(i)) ["start", "end"].includes(e) || r("IR_SCHEMA", "Invalid range field.", [
		...t,
		"range",
		e
	]);
	for (let e of ["start", "end"]) {
		let n = i[e];
		d(n, [
			...t,
			"range",
			e
		]);
		for (let i of Object.keys(n)) ["line", "column"].includes(i) || r("IR_SCHEMA", "Invalid position field.", [
			...t,
			"range",
			e,
			i
		]);
		for (let i of ["line", "column"]) (!Number.isSafeInteger(n[i]) || n[i] < 1) && r("IR_SCHEMA", "Positions start at one.", [
			...t,
			"range",
			e,
			i
		]);
	}
	let { start: a, end: o } = i;
	(o.line < a.line || o.line === a.line && o.column < a.column) && r("IR_SCHEMA", "Source range is reversed.", t);
}
function v(e, t, n = !0) {
	if (d(e, t), e.kind === "optional" && n) f(e, ["kind", "inner"], [], t), v(e.inner, [...t, "inner"], !1);
	else {
		g(e.kind, u, [...t, "kind"]);
		let n = e.kind === "enum" || e.kind === "record";
		f(e, n ? ["kind", "name"] : ["kind"], [], t), n && p(e.name, [...t, "name"]);
	}
	Object.hasOwn(e, "source") && r("IR_SCHEMA", "Type descriptors cannot carry source information.", t);
}
function y(e, t, n) {
	d(e, t), Object.hasOwn(e, "source") && r("IR_SCHEMA", "Resource references cannot carry source information.", t), g(e.kind, [
		"pin",
		"memory",
		"parameter"
	], [...t, "kind"]), e.kind === "parameter" ? (f(e, [
		"kind",
		"resource",
		"index"
	], [], t), g(e.resource, ["pin", "memory"], [...t, "resource"]), h(e.index, [...t, "index"]), n && e.resource !== n && r("IR_REFERENCE", "Resource category does not match.", t)) : (f(e, ["kind", "name"], [], t), p(e.name, [...t, "name"]), n && e.kind !== n && r("IR_REFERENCE", "Resource category does not match.", t));
}
function ne(e, t, n = !1) {
	d(e, t), Object.hasOwn(e, "source") && r("IR_SCHEMA", "Constants and patterns cannot carry source information.", t);
	let i = n ? [
		"number",
		"bool",
		"string",
		"enum",
		"none"
	] : [
		"number",
		"bool",
		"string",
		"bytes",
		"enum",
		"record",
		"none"
	];
	switch (g(e.kind, i, [...t, "kind"]), e.kind) {
		case "none":
			f(e, ["kind"], [], t);
			break;
		case "enum":
			f(e, [
				"kind",
				"name",
				"member"
			], [], t), p(e.name, [...t, "name"]), p(e.member, [...t, "member"]);
			break;
		case "record":
			f(e, [
				"kind",
				"name",
				"fields"
			], [], t), p(e.name, [...t, "name"]), _(e.fields, [...t, "fields"], (e, t) => {
				d(e, t), f(e, ["name", "value"], [], t), p(e.name, [...t, "name"]), ["number", "boolean"].includes(typeof e.value) || r("IR_SCHEMA", "Expected a number or boolean field.", [...t, "value"]);
			});
			break;
		case "bytes":
			f(e, ["kind", "value"], [], t), _(e.value, [...t, "value"], (e, t) => {
				(!Number.isInteger(e) || e < 0 || e > 255) && r("IR_SCHEMA", "Expected a byte.", t);
			});
			break;
		default: f(e, ["kind", "value"], [], t), e.kind === "number" ? (ee(e.value, [...t, "value"]), n && !Number.isFinite(e.value) && r("IR_CONTROL_FLOW", "Numeric match patterns must be finite.", t)) : e.kind === "bool" ? m(e.value, [...t, "value"]) : p(e.value, [...t, "value"]);
	}
}
function b(e, t, n) {
	d(e, t), f(e, ["operations"], [], t), n?.has(e) || _(e.operations, [...t, "operations"], re);
}
function x(e, t, n) {
	d(e, t), f(e, ["type", "body"], [], t), v(e.type, [...t, "type"]), b(e.body, [...t, "body"], n);
}
function re(e, t, n) {
	d(e, t), p(e.kind, [...t, "kind"]);
	let i = [], c = [], l = !1, u = (e) => {
		i = e, l = !0;
	};
	switch (e.kind) {
		case "constant":
			u(["constant"]), ne(e.constant, [...t, "constant"]);
			break;
		case "read":
			u(["resource", "name"]), g(e.resource, [
				"property",
				"const",
				"state",
				"derived"
			], [...t, "resource"]), p(e.name, [...t, "name"]);
			break;
		case "parameter":
		case "reactionCapture":
			u(["index"]), h(e.index, [...t, "index"]);
			break;
		case "reactionValue":
			u(["binding"]), g(e.binding, ["previous", "current"], [...t, "binding"]);
			break;
		case "unary":
			u(["operator", "value"]), g(e.operator, a, [...t, "operator"]);
			break;
		case "binary":
			u([
				"operator",
				"left",
				"right"
			]), g(e.operator, o, [...t, "operator"]);
			break;
		case "numeric":
			u(["builtin", "args"]), g(e.builtin, s, [...t, "builtin"]), _(e.args, [...t, "args"], h);
			break;
		case "record":
			u(["fields"]), _(e.fields, [...t, "fields"], (e, t) => {
				d(e, t), f(e, ["name", "value"], [], t), p(e.name, [...t, "name"]), h(e.value, [...t, "value"]);
			});
			break;
		case "field":
			u(["value", "field"]), p(e.field, [...t, "field"]);
			break;
		case "bytes":
			u(["elements"]), _(e.elements, [...t, "elements"], h);
			break;
		case "length":
		case "optional":
		case "isNone":
		case "nonNull":
			u(["value"]);
			break;
		case "index":
			u(["value", "index"]), h(e.index, [...t, "index"]);
			break;
		case "localRead":
			u(["local"]), h(e.local, [...t, "local"]);
			break;
		case "local":
			i = [
				"local",
				"type",
				"initial"
			], h(e.local, [...t, "local"]), v(e.type, [...t, "type"]);
			break;
		case "localWrite":
			i = ["local", "value"], h(e.local, [...t, "local"]);
			break;
		case "write":
			i = [
				"resource",
				"name",
				"value"
			], g(e.resource, ["state"], [...t, "resource"]), p(e.name, [...t, "name"]);
			break;
		case "memoryLength":
			u(["memory"]), y(e.memory, [...t, "memory"], "memory");
			break;
		case "load8":
		case "load16le":
		case "load16be":
		case "load32le":
		case "load32be":
			u(["memory", "offset"]), y(e.memory, [...t, "memory"], "memory");
			break;
		case "store8":
		case "store16le":
		case "store16be":
		case "store32le":
		case "store32be":
			i = [
				"memory",
				"offset",
				"value"
			], y(e.memory, [...t, "memory"], "memory");
			break;
		case "copyBytes":
			u([
				"memory",
				"offset",
				"length"
			]), y(e.memory, [...t, "memory"], "memory");
			break;
		case "readSample":
			u(["pin"]), y(e.pin, [...t, "pin"], "pin");
			break;
		case "resistor":
			u(["to", "resistance"]), y(e.to, [...t, "to"], "pin");
			break;
		case "combineIntents":
			u(["values"]), _(e.values, [...t, "values"], h);
			break;
		case "refEqual":
			u(["left", "right"]), y(e.left, [...t, "left"]), y(e.right, [...t, "right"]);
			break;
		case "writeIntent":
			i = ["pin", "value"], y(e.pin, [...t, "pin"], "pin");
			break;
		case "call":
		case "callValue":
			i = [
				"name",
				"pure",
				"args"
			], l = e.kind === "callValue", p(e.name, [...t, "name"]), m(e.pure, [...t, "pure"]), _(e.args, [...t, "args"], (e, t) => {
				d(e, t), e.kind === "value" ? (f(e, ["kind", "value"], [], t), h(e.value, [...t, "value"])) : y(e, t);
			});
			break;
		case "send":
			i = ["channel", "value"], p(e.channel, [...t, "channel"]);
			break;
		case "notify":
			i = ["notification"], p(e.notification, [...t, "notification"]);
			break;
		case "receive":
			u(["channel"]), p(e.channel, [...t, "channel"]);
			break;
		case "now":
		case "random":
			u([]);
			break;
		case "if":
			i = ["condition", "yes"], c = ["no"], b(e.yes, [...t, "yes"], n), Object.hasOwn(e, "no") && b(e.no, [...t, "no"], n);
			break;
		case "match":
			i = ["value", "arms"], c = ["otherwise"], _(e.arms, [...t, "arms"], (e, t) => {
				d(e, t), f(e, ["pattern", "body"], [], t), ne(e.pattern, [...t, "pattern"], !0), b(e.body, [...t, "body"], n);
			}), Object.hasOwn(e, "otherwise") && b(e.otherwise, [...t, "otherwise"], n);
			break;
		case "while":
			i = ["test", "body"], x(e.test, [...t, "test"], n), b(e.body, [...t, "body"], n);
			break;
		case "loop":
			i = ["body"], b(e.body, [...t, "body"], n);
			break;
		case "and":
		case "or":
			u(["left", "right"]), x(e.right, [...t, "right"], n);
			break;
		case "select":
			u([
				"condition",
				"yes",
				"no"
			]), x(e.yes, [...t, "yes"], n), x(e.no, [...t, "no"], n);
			break;
		case "assert":
			i = ["condition"], c = ["message"], Object.hasOwn(e, "message") && x(e.message, [...t, "message"], n);
			break;
		case "wait":
		case "elapse":
			i = ["duration"];
			break;
		case "waitUntil":
			i = ["predicate"], p(e.predicate, [...t, "predicate"]);
			break;
		case "redirect":
			i = ["target", "delay"];
			break;
		case "return":
		case "break":
		case "continue":
		case "stop": break;
		case "returnValue":
		case "yield":
			i = ["value"];
			break;
		default: r("IR_SCHEMA", `Unknown operation ${e.kind}.`, [...t, "kind"]);
	}
	f(e, [
		"kind",
		...i,
		...l ? ["result", "type"] : []
	], c, t), l && (h(e.result, [...t, "result"]), v(e.type, [...t, "type"]));
	for (let n of [
		"value",
		"left",
		"right",
		"condition",
		"initial",
		"offset",
		"length",
		"resistance",
		"duration",
		"target",
		"delay"
	]) Object.hasOwn(e, n) && typeof e[n] != "object" && !(n === "value" && ["constant", "read"].includes(e.kind)) ? h(e[n], [...t, n]) : Object.hasOwn(e, n) && typeof e[n] == "object" && ![
		"refEqual",
		"and",
		"or"
	].includes(e.kind) && r("IR_SCHEMA", "Expected a result identifier.", [...t, n]);
}
function ie(e) {
	d(e, []), f(e, [
		"kind",
		"name",
		"declarations"
	], [], []), g(e.kind, ["device"], ["kind"]), p(e.name, ["name"]), _(e.declarations, ["declarations"], (e, t) => {
		d(e, t), p(e.kind, [...t, "kind"]);
		let n = ["kind"], i = [];
		switch (["start", "assert"].includes(e.kind) || (n.push("name"), p(e.name, [...t, "name"])), e.kind) {
			case "enum":
				n.push("members"), _(e.members, [...t, "members"], p);
				break;
			case "record":
				n.push("fields"), _(e.fields, [...t, "fields"], (e, t) => {
					d(e, t), f(e, ["name", "type"], [], t), p(e.name, [...t, "name"]), g(e.type, ["number", "bool"], [...t, "type"]);
				});
				break;
			case "property":
				n.push("type"), i = ["default"], Object.hasOwn(e, "default") && x(e.default, [...t, "default"]);
				break;
			case "const":
			case "derived":
				n.push("type", "value"), x(e.value, [...t, "value"]);
				break;
			case "state":
				n.push("type", "initial"), x(e.initial, [...t, "initial"]);
				break;
			case "pin":
				i = [
					"initial",
					"low",
					"high"
				];
				for (let n of i) Object.hasOwn(e, n) && x(e[n], [...t, n]);
				Object.hasOwn(e, "low") !== Object.hasOwn(e, "high") && r("IR_SCHEMA", "Pin thresholds must be provided together.", t);
				break;
			case "memory":
				n.push("public", "length"), m(e.public, [...t, "public"]), x(e.length, [...t, "length"]);
				break;
			case "channel":
				n.push("direction", "type", "capacity"), i = ["maxLength", "overflow"], x(e.capacity, [...t, "capacity"]);
				for (let n of i) Object.hasOwn(e, n) && x(e[n], [...t, n]);
				break;
			case "notification":
				n.push("direction");
				break;
			case "function":
				n.push("pure", "params", "body"), i = ["returns"], m(e.pure, [...t, "pure"]), _(e.params, [...t, "params"], (e, t) => {
					d(e, t), f(e, ["name", "type"], [], t), p(e.name, [...t, "name"]), d(e.type, [...t, "type"]), ["pin", "memory"].includes(e.type.kind) ? f(e.type, ["kind"], [], [...t, "type"]) : v(e.type, [...t, "type"]);
				}), Object.hasOwn(e, "returns") && v(e.returns, [...t, "returns"]), b(e.body, [...t, "body"]);
				break;
			case "start":
			case "assert":
				n.push("body"), b(e.body, [...t, "body"]);
				break;
			case "on":
				n.push("sourcePath", "body"), _(e.sourcePath, [...t, "sourcePath"], p), b(e.body, [...t, "body"]);
				break;
			case "reaction":
				n.push("sourcePath", "sourceType", "previous", "current", "captures", "body"), _(e.sourcePath, [...t, "sourcePath"], p), v(e.sourceType, [...t, "sourceType"]), p(e.previous, [...t, "previous"]), p(e.current, [...t, "current"]), _(e.captures, [...t, "captures"], (e, t) => {
					d(e, t), f(e, ["name", "value"], [], t), p(e.name, [...t, "name"]), x(e.value, [...t, "value"]);
				}), b(e.body, [...t, "body"]);
				break;
			default: r("IR_SCHEMA", `Unknown declaration ${e.kind}.`, [...t, "kind"]);
		}
		f(e, n, i, t), Object.hasOwn(e, "type") && v(e.type, [...t, "type"]), ["channel", "notification"].includes(e.kind) && g(e.direction, ["input", "output"], [...t, "direction"]);
	});
}
function ae(e) {
	d(e, []), f(e, ["kind", "instructions"], [], []), g(e.kind, ["block"], ["kind"]), _(e.instructions, ["instructions"], (e, t) => {
		d(e, t), f(e, [
			"pc",
			"nextPc",
			"body"
		], [], t);
		for (let n of ["pc", "nextPc"]) typeof e[n] == "number" && Number.isFinite(e[n]) || r("IR_SCHEMA", "Instruction positions must be finite numbers.", [...t, n]);
		b(e.body, [...t, "body"]);
	});
	let t = e.instructions;
	t.length || r("IR_JIT_BOUNDARY", "A block requires at least one instruction.", ["instructions"]);
	for (let e = 1; e < t.length; e++) t[e - 1].nextPc !== t[e].pc && r("IR_JIT_BOUNDARY", "Adjacent instruction boundaries do not match.", [
		"instructions",
		e,
		"pc"
	]);
}
var S = { kind: "number" }, C = { kind: "bool" }, oe = { kind: "string" }, se = { kind: "bytes" }, ce = { kind: "intent" }, le = { kind: "sample" }, ue = /* @__PURE__ */ new Set([
	"device",
	"default",
	"const",
	"let",
	"enum",
	"record",
	"state",
	"derived",
	"pin",
	"memory",
	"fn",
	"pure",
	"process",
	"on",
	"reaction",
	"as",
	"capture",
	"if",
	"else",
	"match",
	"while",
	"loop",
	"break",
	"continue",
	"return",
	"await",
	"assert",
	"redirect",
	"true",
	"false",
	"none",
	"start",
	"number",
	"bool",
	"string",
	"bytes",
	"sample",
	"intent",
	"NaN",
	"Infinity",
	...Object.keys(i),
	...s,
	...c,
	...l,
	"resistor",
	"copyBytes",
	"now",
	"random",
	"ticks"
]);
function de(e, t) {
	let n = e, r = t;
	return n?.kind === r?.kind && (n?.kind === "optional" ? de(n.inner, r?.inner) : n?.kind === "enum" || n?.kind === "record" ? n.name === r?.name : !0);
}
function fe(e) {
	return e.kind === "optional" ? e.inner : e;
}
function pe(e) {
	return fe(e).kind !== "intent";
}
function me(e) {
	return {
		facts: new Map(e.facts),
		locals: new Map(e.locals)
	};
}
function he(e) {
	let t = new Map(e[0]);
	for (let [n, r] of t) e.some((e) => e.get(n) !== r) && t.delete(n);
	return t;
}
var ge = class {
	next = 0;
	byKey = /* @__PURE__ */ new Map();
	joins = /* @__PURE__ */ new Map();
	fields = /* @__PURE__ */ new Map();
	id(e) {
		let t = this.byKey.get(e);
		return t === void 0 && (t = this.byKey.size, this.byKey.set(e, t)), t;
	}
	fresh(e) {
		return `${e}:${this.next++}`;
	}
	join(e, t) {
		let n = `${e}:${t.map((e) => this.id(e)).join(",")}`, r = this.joins.get(n);
		return r === void 0 && (r = this.fresh("join"), this.joins.set(n, r)), r;
	}
	field(e, t) {
		let n = this.fields.get(e);
		n || (n = /* @__PURE__ */ new Map(), this.fields.set(e, n));
		let r = n.get(t);
		return r === void 0 && (r = this.fresh("field"), n.set(t, r)), r;
	}
};
function _e(e, t) {
	for (let n of [
		e.normal,
		...e.breaks,
		...e.continues,
		...e.yieldStates
	]) if (n) for (let e of n.locals.keys()) t.has(e) || n.locals.delete(e);
	return e;
}
function w(e, t) {
	if (!e.length) return;
	let n = me(e[0]);
	n.facts = he(e.map((e) => e.facts));
	for (let [r, i] of n.locals) {
		let a = e.map((e) => e.locals.get(r));
		if (a.some((e) => !e)) n.locals.delete(r);
		else if (a.some((e) => e.value.key !== i.value.key)) {
			let o = {
				type: i.type,
				key: t.join(r, a.map((e) => e.value.key))
			}, s = a.map((t, n) => e[n].facts.get(t.value.key));
			s.every((e) => e === !0) && n.facts.set(o.key, !0), s.every((e) => e === !1) && n.facts.set(o.key, !1), n.locals.set(r, {
				type: i.type,
				value: o
			});
		}
	}
	return n;
}
function T(e, t, n = []) {
	e.operations.forEach((e, r) => {
		let i = [
			...n,
			"operations",
			r
		];
		t(e, i);
		for (let n of [
			"yes",
			"no",
			"otherwise",
			"body"
		]) {
			let r = n in e ? e[n] : void 0;
			if (r) {
				let e = "body" in r;
				T(e ? r.body : r, t, [
					...i,
					n,
					...e ? ["body"] : []
				]);
			}
		}
		e.kind === "while" && T(e.test.body, t, [
			...i,
			"test",
			"body"
		]), e.kind === "assert" && e.message && T(e.message.body, t, [
			...i,
			"message",
			"body"
		]), (e.kind === "and" || e.kind === "or") && T(e.right.body, t, [
			...i,
			"right",
			"body"
		]), e.kind === "match" && e.arms.forEach((e, n) => T(e.body, t, [
			...i,
			"arms",
			n,
			"body"
		]));
	});
}
var ve = class {
	declarations = /* @__PURE__ */ new Map();
	paths = /* @__PURE__ */ new Map();
	enums = new Map(Object.entries(i));
	records = /* @__PURE__ */ new Map();
	functions = /* @__PURE__ */ new Map();
}, ye = /* @__PURE__ */ new WeakMap();
function be(e) {
	return ye.get(e)?.declarations;
}
var xe = class {
	device;
	index;
	identities = new ge();
	effectChecked = /* @__PURE__ */ new Set();
	receiveOwners = /* @__PURE__ */ new Map();
	constructor(e) {
		this.device = e;
		let t = e && ye.get(e);
		if (this.index = t ?? new ve(), !e || t) return;
		let { declarations: n, paths: r, enums: i, records: a, functions: o } = this.index;
		this.name(e.name, ["name"]);
		let s = 0;
		e.declarations.forEach((e, t) => {
			let c = ["declarations", t];
			e.kind === "start" ? ++s > 1 && this.error("IR_REFERENCE", "Only one start process is allowed.", c) : e.kind !== "assert" && (this.name(e.name, [...c, "name"]), n.has(e.name) && this.error("IR_REFERENCE", `Duplicate declaration ${e.name}.`, c), n.set(e.name, e), r.set(e.name, c), e.kind === "enum" && (this.uniqueNames(e.members, [...c, "members"]), e.members.length || this.error("IR_TYPE", "An enum must have at least one member.", c), i.set(e.name, e.members)), e.kind === "record" && (this.uniqueNames(e.fields.map((e) => e.name), [...c, "fields"]), a.set(e.name, e.fields)), e.kind === "function" && o.set(e.name, e));
		});
	}
	get declarations() {
		return this.index.declarations;
	}
	get paths() {
		return this.index.paths;
	}
	get enums() {
		return this.index.enums;
	}
	get records() {
		return this.index.records;
	}
	get functions() {
		return this.index.functions;
	}
	error(e, t, n, i) {
		return r(e, t, n, "finalize", i?.source);
	}
	name(e, t) {
		(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e) || ue.has(e)) && this.error("IR_REFERENCE", `Invalid or reserved identifier ${e}.`, t);
	}
	uniqueNames(e, t, n = !1) {
		let r = /* @__PURE__ */ new Set();
		e.forEach((e, i) => {
			n ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(e) || this.error("IR_REFERENCE", "Invalid member name.", [...t, i]) : this.name(e, [...t, i]), r.has(e) && this.error("IR_REFERENCE", `Duplicate name ${e}.`, [...t, i]), r.add(e);
		});
	}
	type(e, t) {
		let n = fe(e);
		n.kind === "enum" && !this.enums.has(n.name) && this.device && this.error("IR_REFERENCE", `Unknown enum ${n.name}.`, t), n.kind === "record" && !this.records.has(n.name) && this.device && this.error("IR_REFERENCE", `Unknown record ${n.name}.`, t);
	}
	expect(e, t, n, r) {
		de(e, t) || this.error("IR_TYPE", `Expected ${this.describe(t)}, received ${this.describe(e)}.`, n, r);
	}
	describe(e) {
		let t = e;
		return t ? t.kind === "optional" ? `${this.describe(t.inner)}?` : String(t.name ?? t.kind) : "no value";
	}
	declaration(e, t, n) {
		if (!this.device) return;
		let r = this.declarations.get(e);
		return r && r.kind === t || this.error("IR_REFERENCE", `Expected ${t} declaration ${e}.`, n), r;
	}
	ref(e, t, n, r) {
		let i = e.kind === "parameter" ? e.resource : e.kind;
		if (t && i !== t && this.error("IR_REFERENCE", "Resource category does not match.", r), e.kind === "parameter") {
			let t = n.params[e.index];
			t || this.error("IR_SCOPE", "Resource parameter is outside the current function.", r), t.type.kind !== i && this.error("IR_REFERENCE", "Resource parameter category does not match.", r);
		} else this.declaration(e.name, i, r);
		return i;
	}
	field(e, t, n) {
		if (e.kind === "sample") {
			let e = {
				voltage: {
					kind: "optional",
					inner: S
				},
				level: {
					kind: "enum",
					name: "Logic"
				},
				status: {
					kind: "enum",
					name: "SampleStatus"
				}
			};
			return e[t] || this.error("IR_REFERENCE", `Unknown sample field ${t}.`, n), e[t];
		}
		e.kind !== "record" && this.error("IR_TYPE", "Field access requires a record or sample.", n);
		let r = this.records.get(e.name);
		if (!r && !this.device) return S;
		let i = r?.find((e) => e.name === t);
		return i || this.error("IR_REFERENCE", `Unknown record field ${t}.`, n), { kind: i.type };
	}
	constant(e, t, n) {
		if (e.kind === "none") t.kind !== "optional" && this.error("IR_TYPE", "none requires an optional result type.", n);
		else {
			if (t.kind === "optional" && this.error("IR_TYPE", "Non-null constants require a nonoptional type and explicit optional lift.", n), (e.kind !== t.kind || (e.kind === "enum" || e.kind === "record") && e.name !== ("name" in t ? t.name : void 0)) && this.error("IR_TYPE", "Constant and result types do not match.", n), e.kind === "enum") {
				let t = this.enums.get(e.name);
				t && !t.includes(e.member) && this.error("IR_REFERENCE", `Unknown enum member ${e.member}.`, n);
			}
			e.kind === "record" && this.recordFields(e.fields, t, n, (e) => ({ kind: typeof e.value == "boolean" ? "bool" : "number" }));
		}
	}
	recordFields(e, t, n, r) {
		t.kind !== "record" && this.error("IR_TYPE", "Record construction requires a named record type.", n);
		let i = this.records.get(t.name), a = /* @__PURE__ */ new Set();
		for (let t = 0; t < e.length; t++) {
			let o = e[t];
			if (a.has(o.name) && this.error("IR_REFERENCE", "Duplicate record field.", [
				...n,
				"fields",
				t
			]), a.add(o.name), i) {
				let e = i.find((e) => e.name === o.name);
				e || this.error("IR_REFERENCE", `Unknown record field ${o.name}.`, [
					...n,
					"fields",
					t
				]), this.expect(r(o), { kind: e.type }, [
					...n,
					"fields",
					t
				]);
			} else r(o);
		}
		i && i.length !== e.length && this.error("IR_TYPE", "Record fields are incomplete.", n);
	}
	context(e, t) {
		return {
			mode: e,
			params: [],
			...t ? { returns: t } : {},
			loop: 0,
			results: /* @__PURE__ */ new Map(),
			visibleResults: [],
			resultIds: /* @__PURE__ */ new Set(),
			localIds: /* @__PURE__ */ new Set(),
			tail: !0,
			finalInstruction: !0,
			computation: !1
		};
	}
	body(e, t, n) {
		let r = this.region(e, t, {
			facts: /* @__PURE__ */ new Map(),
			locals: /* @__PURE__ */ new Map()
		}, n);
		t.returns && r.normal && this.error("IR_CONTROL_FLOW", "A value-returning body has a normal path without returnValue.", n, e), this.effects(e, t.mode, n);
	}
	computation(e, t, n, r) {
		this.type(e.type, [...r, "type"]), this.expect(e.type, t, [...r, "type"]);
		let i = this.context(n, t);
		i.computation = !0, this.body(e.body, i, [...r, "body"]);
	}
	conditioned(e, t, n) {
		let r = me(e), i = n ? t.yes : t.no;
		if (i) for (let [e, t] of i) r.facts.set(e, t);
		return r;
	}
	region(e, t, n, r) {
		let i = me(n), a = {
			breaks: [],
			continues: [],
			yielded: [],
			yieldStates: []
		}, { results: o, visibleResults: s } = t, c = s.length;
		for (let n = 0; n < e.operations.length; n++) {
			let c = e.operations[n], l = [
				...r,
				"operations",
				n
			];
			i || this.error("IR_CONTROL_FLOW", "Operation follows an unconditional path terminator.", l, c);
			let u = i, d = (e, t) => {
				let n = o.get(e);
				return n || this.error("IR_SCOPE", `Result ${e} is not visible or is used before its definition.`, l, c), t && this.expect(n.type, t, l, c), n;
			}, f = (e, t = {}) => {
				let n = c;
				this.expect(n.type, e, [...l, "type"], c);
				let r = {
					type: n.type,
					key: `v:${n.result}`,
					...t
				};
				return o.set(n.result, r), s.push(n.result), r;
			};
			"result" in c && (this.type(c.type, [...l, "type"]), t.resultIds.has(c.result) && this.error("IR_SCOPE", `Duplicate result ${c.result}.`, [...l, "result"], c), t.resultIds.add(c.result));
			let p = (e) => {
				let t = u.locals.get(e);
				return t || this.error("IR_SCOPE", "Local is not visible or not initialized.", [...l, "local"], c), t;
			}, m = (r, i, a, o = {}) => _e(this.region(r, {
				...t,
				tail: t.tail && n === e.operations.length - 1,
				...o
			}, i, [...l, a]), i.locals), ee = (e) => {
				a.breaks.push(...e.breaks), a.continues.push(...e.continues), a.yielded.push(...e.yielded), a.yieldStates.push(...e.yieldStates);
			}, h = (e, n, r, i) => {
				this.type(e.type, [
					...l,
					i,
					"type"
				]), this.expect(e.type, n, [
					...l,
					i,
					"type"
				]);
				let a = _e(this.region(e.body, {
					...t,
					valueRegion: n,
					loop: 0,
					tail: !1
				}, r, [
					...l,
					i,
					"body"
				]), r.locals);
				return a.normal && this.error("IR_CONTROL_FLOW", "A value region has a normal path without yield.", [...l, i], e), {
					flow: a,
					...a.yielded.length ? { value: {
						type: n,
						key: `region:${"result" in c ? c.result : void 0}:${i}`,
						yes: he(a.yielded.map((e) => e.yes ?? /* @__PURE__ */ new Map())),
						no: he(a.yielded.map((e) => e.no ?? /* @__PURE__ */ new Map()))
					} } : {}
				};
			};
			switch (c.kind) {
				case "constant": {
					this.constant(c.constant, c.type, [...l, "constant"]);
					let e = f(c.type, { none: c.constant.kind === "none" });
					c.constant.kind === "none" && u.facts.set(e.key, !1);
					break;
				}
				case "read":
					f(this.declaration(c.name, c.resource, l)?.type ?? c.type);
					break;
				case "parameter": {
					let e = t.params[c.index];
					e || this.error("IR_SCOPE", "Parameter index is outside the current function.", l, c), (e.type.kind === "pin" || e.type.kind === "memory") && this.error("IR_TYPE", "Resource parameters cannot be read as values.", l, c), f(e.type, { key: `parameter:${c.index}` });
					break;
				}
				case "reactionValue":
					t.reaction || this.error("IR_SCOPE", "Reaction bindings are only visible inside their response body.", l, c), f(t.reaction.sourceType, { key: `reaction:${c.binding}` });
					break;
				case "reactionCapture":
					t.reaction || this.error("IR_SCOPE", "Reaction captures are only visible inside their response body.", l, c), t.reaction.captures[c.index] || this.error("IR_SCOPE", "Reaction capture index is out of range.", l, c), f(t.reaction.captures[c.index].value.type, { key: `capture:${c.index}` });
					break;
				case "unary": {
					let e = d(c.value, c.operator === "not" ? C : S);
					f(c.operator === "not" ? C : S, c.operator === "not" ? {
						yes: e.no ?? /* @__PURE__ */ new Map(),
						no: e.yes ?? /* @__PURE__ */ new Map()
					} : {});
					break;
				}
				case "binary": {
					let e = d(c.left), t = d(c.right);
					if (["equal", "notEqual"].includes(c.operator)) {
						this.expect(e.type, t.type, l, c), pe(e.type) || e.type.kind === "optional" && (e.none || t.none) || this.error("IR_TYPE", "Intent values do not support content equality.", l, c);
						let n = e.none ? t : t.none ? e : void 0, r = c.operator === "equal";
						f(C, n ? {
							yes: /* @__PURE__ */ new Map([[n.key, !r]]),
							no: /* @__PURE__ */ new Map([[n.key, r]])
						} : {});
					} else c.operator === "concat" ? (d(c.left, oe), d(c.right, oe), f(oe)) : (d(c.left, S), d(c.right, S), f([
						"lessThan",
						"lessThanOrEqual",
						"greaterThan",
						"greaterThanOrEqual"
					].includes(c.operator) ? C : S));
					break;
				}
				case "numeric":
					c.args.length !== ([
						"min",
						"max",
						"pow"
					].includes(c.builtin) ? 2 : 1) && this.error("IR_TYPE", "Numeric builtin argument count does not match.", l, c), c.args.forEach((e) => d(e, S)), f(c.builtin.startsWith("is") ? C : S);
					break;
				case "record":
					this.recordFields(c.fields, c.type, l, (e) => d(e.value).type), f(c.type);
					break;
				case "field": {
					let e = d(c.value), t = e.type;
					f(t.kind === "record" && !this.device ? c.type : this.field(t, c.field, l), { key: this.identities.field(e.key, c.field) });
					break;
				}
				case "bytes":
					c.elements.forEach((e) => d(e, S)), f(se);
					break;
				case "length": {
					let e = d(c.value).type;
					["string", "bytes"].includes(e.kind) || this.error("IR_TYPE", "length requires string or bytes.", l, c), f(S);
					break;
				}
				case "index": {
					let e = d(c.value).type;
					["string", "bytes"].includes(e.kind) || this.error("IR_TYPE", "index requires string or bytes.", l, c), d(c.index, S), f(e.kind === "string" ? oe : S);
					break;
				}
				case "optional": {
					let e = d(c.value).type;
					e.kind === "optional" && this.error("IR_TYPE", "Optional types cannot be nested.", l, c);
					let t = f({
						kind: "optional",
						inner: e
					});
					u.facts.set(t.key, !0);
					break;
				}
				case "isNone": {
					let e = d(c.value);
					e.type.kind !== "optional" && this.error("IR_TYPE", "isNone requires an optional value.", l, c), f(C, {
						yes: /* @__PURE__ */ new Map([[e.key, !1]]),
						no: /* @__PURE__ */ new Map([[e.key, !0]])
					});
					break;
				}
				case "nonNull": {
					let e = d(c.value);
					(e.type.kind !== "optional" || u.facts.get(e.key) !== !0) && this.error("IR_TYPE", "nonNull requires a dominating non-null proof.", l, c), f(e.type.inner);
					break;
				}
				case "local": {
					t.localIds.has(c.local) && this.error("IR_SCOPE", "Duplicate local identifier.", l, c), t.localIds.add(c.local), this.type(c.type, [...l, "type"]);
					let e = d(c.initial, c.type);
					u.locals.set(c.local, {
						type: c.type,
						value: e
					});
					break;
				}
				case "localRead": {
					let e = p(c.local);
					f(e.type, { ...e.value });
					break;
				}
				case "localWrite": {
					let e = p(c.local), t = d(c.value, e.type);
					u.locals.set(c.local, {
						type: e.type,
						value: t
					});
					break;
				}
				case "write": {
					let e = this.declaration(c.name, "state", l);
					d(c.value, e?.type);
					break;
				}
				case "memoryLength":
					this.ref(c.memory, "memory", t, l), f(S);
					break;
				case "load8":
				case "load16le":
				case "load16be":
				case "load32le":
				case "load32be":
					this.ref(c.memory, "memory", t, l), d(c.offset, S), f(S);
					break;
				case "store8":
				case "store16le":
				case "store16be":
				case "store32le":
				case "store32be":
					this.ref(c.memory, "memory", t, l), d(c.offset, S), d(c.value, S);
					break;
				case "copyBytes":
					this.ref(c.memory, "memory", t, l), d(c.offset, S), d(c.length, S), f(se);
					break;
				case "readSample":
					this.ref(c.pin, "pin", t, l), f(le);
					break;
				case "resistor":
					this.ref(c.to, "pin", t, l), d(c.resistance, S), f(ce);
					break;
				case "combineIntents":
					c.values.forEach((e) => d(e, ce)), f(ce);
					break;
				case "refEqual":
					this.expect({ kind: this.ref(c.left, void 0, t, l) }, { kind: this.ref(c.right, void 0, t, l) }, l), f(C);
					break;
				case "writeIntent":
					this.ref(c.pin, "pin", t, l), d(c.value, ce);
					break;
				case "call":
				case "callValue": {
					let e = this.declaration(c.name, "function", l);
					e && c.pure && !e.pure && this.error("IR_EFFECT", "A pure call must target an explicitly pure function.", l, c), e && c.args.length !== e.params.length && this.error("IR_TYPE", "Call argument count does not match.", l, c), c.args.forEach((n, r) => {
						let i = e?.params[r];
						n.kind === "value" ? (i && (i.type.kind === "pin" || i.type.kind === "memory") && this.error("IR_TYPE", "Resource argument required.", l, c), d(n.value, i?.type)) : (i && i.type.kind !== "pin" && i.type.kind !== "memory" && this.error("IR_TYPE", "Value argument required.", l, c), this.ref(n, i?.type.kind, t, l));
					}), c.kind === "callValue" ? (e && !e.returns && this.error("IR_TYPE", "callValue requires a value-returning function.", l, c), f(e?.returns ?? c.type)) : e?.returns && this.error("IR_TYPE", "call cannot discard the return type of a value-returning function.", l, c);
					break;
				}
				case "send": {
					let e = this.declaration(c.channel, "channel", l);
					e?.direction === "input" && this.error("IR_REFERENCE", "send requires an output channel.", l, c), d(c.value, e?.type);
					break;
				}
				case "notify":
					this.declaration(c.notification, "notification", l)?.direction === "input" && this.error("IR_REFERENCE", "notify requires an output notification.", l, c);
					break;
				case "receive": {
					let e = this.declaration(c.channel, "channel", l);
					e?.direction === "output" && this.error("IR_REFERENCE", "receive requires an input channel.", l, c), f(e?.type ?? c.type);
					break;
				}
				case "now":
				case "random":
					f(S);
					break;
				case "if": {
					let e = d(c.condition, C), t = m(c.yes, this.conditioned(u, e, !0), "yes"), n = c.no ? m(c.no, this.conditioned(u, e, !1), "no") : {
						normal: this.conditioned(u, e, !1),
						breaks: [],
						continues: [],
						yielded: [],
						yieldStates: []
					};
					ee(t), ee(n), i = w([t.normal, n.normal].filter((e) => !!e), this.identities);
					break;
				}
				case "match": {
					let r = d(c.value), a = fe(r.type), o = /* @__PURE__ */ new Set(), s = [];
					for (let i = 0; i < c.arms.length; i++) {
						let d = c.arms[i], f = d.pattern;
						this.constant(f, f.kind === "none" ? r.type : a, [
							...l,
							"arms",
							i,
							"pattern"
						]);
						let p = f.kind === "enum" ? `${f.name}.${f.member}` : `${f.kind}:${String("value" in f ? f.value : void 0)}`;
						o.has(p) && this.error("IR_CONTROL_FLOW", "Duplicate match pattern.", [
							...l,
							"arms",
							i
						]), o.add(p);
						let m = me(u);
						r.type.kind === "optional" && m.facts.set(r.key, f.kind !== "none");
						let h = _e(this.region(d.body, {
							...t,
							tail: t.tail && n === e.operations.length - 1
						}, m, [
							...l,
							"arms",
							i,
							"body"
						]), m.locals);
						ee(h), h.normal && s.push(h.normal);
					}
					let f = (a.kind === "bool" ? o.has("bool:true") && o.has("bool:false") : a.kind === "enum" && this.enums.get(a.name)?.every((e) => o.has(`${a.name}.${e}`))) && (r.type.kind !== "optional" || o.has("none:undefined"));
					if (c.otherwise) {
						let e = me(u);
						r.type.kind === "optional" && o.has("none:undefined") && e.facts.set(r.key, !0);
						let t = m(c.otherwise, e, "otherwise");
						ee(t), t.normal && s.push(t.normal);
					} else f || this.error("IR_CONTROL_FLOW", "Match requires exhaustive patterns or a default region.", l, c);
					i = w(s, this.identities);
					break;
				}
				case "while":
				case "loop": {
					let e = /* @__PURE__ */ new Set();
					T(c.body, (t) => {
						t.kind === "localWrite" && u.locals.has(t.local) && e.add(t.local);
					}), c.kind === "while" && T(c.test.body, (t) => {
						t.kind === "localWrite" && u.locals.has(t.local) && e.add(t.local);
					});
					let n = (t) => {
						let n = me(u), r = [u, ...t];
						for (let t of e) {
							let e = u.locals.get(t), i = {
								type: e.type,
								key: `loop:${l.join(".")}:${t}`
							};
							n.locals.set(t, {
								type: e.type,
								value: i
							});
							let a = r.map((e) => {
								let n = e.locals.get(t)?.value;
								return n ? e.facts.get(n.key) : void 0;
							});
							a.every((e) => e === !0) ? n.facts.set(i.key, !0) : a.every((e) => e === !1) && n.facts.set(i.key, !1);
						}
						return n;
					}, r = n([]), o = new Set(t.resultIds), s = new Set(t.localIds), d, f;
					for (;;) {
						t.resultIds.clear();
						for (let e of o) t.resultIds.add(e);
						t.localIds.clear();
						for (let e of s) t.localIds.add(e);
						d = c.kind === "while" ? h(c.test, C, r, "test") : void 0;
						let i = d ? w(d.flow.yieldStates, this.identities) ?? r : r, a = d?.value ? this.conditioned(i, d.value, !0) : i;
						f = m(c.body, a, "body", {
							loop: t.loop + 1,
							tail: !1
						});
						let l = n([f.normal, ...f.continues].filter((e) => !!e));
						if ([...e].every((e) => {
							let t = l.locals.get(e).value.key;
							return l.facts.get(t) === r.facts.get(t);
						})) break;
						r = l;
					}
					a.yielded.push(...f.yielded), a.yieldStates.push(...f.yieldStates);
					let p = [...f.breaks];
					if (c.kind === "while" && d?.value) {
						let e = w(d.flow.yieldStates, this.identities) ?? r;
						p.push(this.conditioned(e, d.value, !1));
					}
					i = w(p, this.identities);
					break;
				}
				case "and":
				case "or": {
					let e = d(c.left, C), t = c.kind === "and", n = h(c.right, C, this.conditioned(u, e, t), "right"), r = n.value, a = (e, t) => new Map([...e ?? [], ...t ?? []]);
					f(C, {
						yes: t ? a(e.yes, r?.yes) : he([e.yes ?? /* @__PURE__ */ new Map(), a(e.no, r?.yes)]),
						no: t ? he([e.no ?? /* @__PURE__ */ new Map(), a(e.yes, r?.no)]) : a(e.no, r?.no)
					}), i = w([this.conditioned(u, e, !t), ...n.flow.yieldStates], this.identities);
					break;
				}
				case "select": {
					let e = d(c.condition, C), t = h(c.yes, c.type, this.conditioned(u, e, !0), "yes"), n = h(c.no, c.type, this.conditioned(u, e, !1), "no");
					f(c.type), i = w([...t.flow.yieldStates, ...n.flow.yieldStates], this.identities);
					break;
				}
				case "assert": {
					let e = d(c.condition, C);
					c.message && h(c.message, oe, this.conditioned(u, e, !1), "message"), i = this.conditioned(u, e, !0);
					break;
				}
				case "wait":
					(t.valueRegion || t.mode !== "process") && this.error("IR_EFFECT", "wait is only allowed in a process statement region.", l, c), d(c.duration, S);
					break;
				case "elapse":
					(t.valueRegion || t.mode !== "jit") && this.error("IR_EFFECT", "elapse is only allowed in a JIT statement region.", l, c), d(c.duration, S);
					break;
				case "waitUntil":
					t.mode !== "jit" && this.error("IR_EFFECT", "waitUntil requires a JIT instruction.", l, c), (t.valueRegion || t.loop || !t.tail || n !== e.operations.length - 1 || !t.finalInstruction) && this.error("IR_JIT_BOUNDARY", "waitUntil must be on the final instruction tail path.", l, c);
					{
						let e = this.declaration(c.predicate, "function", l);
						e && (!e.pure || e.params.length || !de(e.returns, C)) && this.error("IR_TYPE", "waitUntil requires a zero-parameter pure bool function.", l, c);
					}
					i = void 0;
					break;
				case "redirect":
					["jit", "sync"].includes(t.mode) || this.error("IR_EFFECT", "redirect is not permitted in this context.", l, c), d(c.target, S), d(c.delay, S), i = void 0;
					break;
				case "stop":
					(t.mode !== "jit" || t.valueRegion) && this.error("IR_EFFECT", "stop requires a JIT statement region.", l, c), i = void 0;
					break;
				case "return":
					(t.valueRegion || t.returns || t.mode === "jit" || t.computation || t.mode === "creation" || t.mode === "initial") && this.error("IR_CONTROL_FLOW", "Void return is not valid in this body.", l, c), i = void 0;
					break;
				case "returnValue":
					(t.valueRegion || !t.returns) && this.error("IR_CONTROL_FLOW", "returnValue is not valid in this body.", l, c), d(c.value, t.returns), i = void 0;
					break;
				case "yield":
					t.valueRegion || this.error("IR_CONTROL_FLOW", "yield requires a value region.", l, c);
					{
						let e = d(c.value, t.valueRegion);
						a.yielded.push(e), a.yieldStates.push(u);
					}
					i = void 0;
					break;
				case "break":
				case "continue": t.loop || this.error("IR_CONTROL_FLOW", `${c.kind} requires an enclosing loop in this region.`, l, c), (c.kind === "break" ? a.breaks : a.continues).push(u), i = void 0;
			}
		}
		for (i && (a.normal = i); s.length > c;) o.delete(s.pop());
		return a;
	}
	effects(e, t, n) {
		T(e, (e, n) => {
			let r = [
				"creation",
				"initial",
				"pure"
			].includes(t), i = ["creation", "initial"].includes(t), a = [
				"write",
				"writeIntent",
				"send",
				"notify",
				"now",
				"random",
				"wait",
				"receive",
				"elapse",
				"waitUntil",
				"stop",
				"redirect",
				...l
			].includes(e.kind);
			if (r && a && this.error("IR_EFFECT", `${e.kind} is not allowed in ${t} code.`, n, e), i && (e.kind === "read" && !["property", "const"].includes(e.resource) || [
				"readSample",
				"memoryLength",
				"copyBytes",
				...c
			].includes(e.kind)) && this.error("IR_EFFECT", "Creation computations cannot read runtime resources.", n, e), t === "creation" && ([
				"resistor",
				"combineIntents",
				"refEqual"
			].includes(e.kind) || (e.kind === "call" || e.kind === "callValue") && e.args.some((e) => e.kind !== "value")) && this.error("IR_EFFECT", "Ordinary creation computations cannot use resource references or intents.", n, e), ["reaction", "process"].includes(t) && e.kind === "redirect" && this.error("IR_EFFECT", "Control redirection requires a bound JIT entry.", n, e), [
				"sync",
				"reaction",
				"pure"
			].includes(t) && [
				"wait",
				"receive",
				"elapse",
				"waitUntil",
				"stop"
			].includes(e.kind) && this.error("IR_EFFECT", "Synchronous code cannot suspend or use JIT control.", n, e), t === "process" && [
				"elapse",
				"waitUntil",
				"stop"
			].includes(e.kind) && this.error("IR_EFFECT", "Process code cannot use JIT control.", n, e), t === "jit" && ["wait", "receive"].includes(e.kind) && this.error("IR_EFFECT", "JIT code cannot use process suspension.", n, e), e.kind === "call" || e.kind === "callValue" || e.kind === "waitUntil") {
				let i = e.kind === "waitUntil" ? e.predicate : e.name, a = this.functions.get(i);
				if (a && r && !a.pure && this.error("IR_EFFECT", "Pure contexts can only call explicitly pure functions.", n, e), a && t !== "jit") {
					let e = `${t}:${i}`;
					this.effectChecked.has(e) || (this.effectChecked.add(e), this.effects(a.body, t, [...this.paths.get(i) ?? [], "body"]));
				}
			}
		}, n);
	}
	source(e, t, n) {
		e.length || this.error("IR_SCHEMA", "An observation source path cannot be empty.", t);
		let r = this.declarations.get(e[0]);
		r || this.error("IR_REFERENCE", "Observation source does not exist.", t);
		let i, a = 1;
		if (r.kind === "notification" && n) (r.direction !== "input" || e.length !== 1) && this.error("IR_REFERENCE", "Only input notifications can trigger a process.", t);
		else {
			r.kind === "pin" ? (e[1] !== "sample" && this.error("IR_REFERENCE", "Pin observation must select sample.", t), i = le, a = 2) : r.kind === "state" || r.kind === "derived" ? i = r.type : this.error("IR_REFERENCE", "An observation source must be state, derived, pin.sample or an input notification.", t);
			for (let n = a; n < e.length; n++) i = this.field(i, e[n], [...t, n]);
			return pe(i) || this.error("IR_TYPE", "Observation sources must be comparable.", t), i;
		}
	}
	cycle(e, t) {
		let n = /* @__PURE__ */ new Set(), r = /* @__PURE__ */ new Set(), i = (a) => {
			if (n.has(a) && this.error("IR_DEPENDENCY", `${t} dependency cycle includes ${a}.`, this.paths.get(a) ?? []), !r.has(a)) {
				n.add(a);
				for (let t of e.get(a) ?? []) e.has(t) && i(t);
				n.delete(a), r.add(a);
			}
		};
		for (let t of e.keys()) i(t);
	}
	dependencies(e, t, n = /* @__PURE__ */ new Set()) {
		let r = /* @__PURE__ */ new Set();
		return T(e, (e) => {
			if (e.kind === "read" && t.includes(e.resource) && r.add(e.name), (e.kind === "call" || e.kind === "callValue") && !n.has(e.name)) {
				n.add(e.name);
				let i = this.functions.get(e.name);
				if (i) for (let e of this.dependencies(i.body, t, n)) r.add(e);
			}
		}), r;
	}
	validateDevice() {
		let e = /* @__PURE__ */ new Map();
		for (let [t, n] of this.functions) {
			let r = /* @__PURE__ */ new Set();
			T(n.body, (e) => {
				(e.kind === "call" || e.kind === "callValue") && r.add(e.name);
			}), e.set(t, r);
		}
		this.cycle(e, "Synchronous call");
		let t = /* @__PURE__ */ new Map(), r = /* @__PURE__ */ new Map();
		this.device.declarations.forEach((e, i) => {
			let a = ["declarations", i];
			if ("type" in e && e.type && this.type(e.type, [...a, "type"]), e.kind === "property" || e.kind === "const" || e.kind === "state") {
				let n = fe(e.type);
				(["sample", "intent"].includes(n.kind) || e.kind === "property" && n.kind === "record") && this.error("IR_TYPE", "Type is not valid at this declaration position.", [...a, "type"], e);
				let r = e.kind === "property" ? "default" : e.kind === "const" ? "value" : "initial", i = e.kind === "property" ? e.default : e.kind === "const" ? e.value : e.initial;
				i && (this.computation(i, e.type, "creation", [...a, r]), t.set(e.name, this.dependencies(i.body, ["property", "const"])));
			} else if (e.kind === "derived") this.computation(e.value, e.type, "pure", [...a, "value"]), r.set(e.name, this.dependencies(e.value.body, ["derived"]));
			else if (e.kind === "pin") {
				for (let t of ["low", "high"]) e[t] && this.computation(e[t], S, "creation", [...a, t]);
				e.initial && this.computation(e.initial, ce, "initial", [...a, "initial"]);
			} else if (e.kind === "memory") this.computation(e.length, S, "creation", [...a, "length"]);
			else if (e.kind === "channel") [
				"number",
				"bool",
				"record",
				"bytes"
			].includes(e.type.kind) || this.error("IR_TYPE", "Invalid channel payload type.", [...a, "type"], e), e.type.kind === "bytes" != !!e.maxLength && this.error("IR_TYPE", "Only bytes channels require maxLength.", a, e), this.computation(e.capacity, S, "creation", [...a, "capacity"]), e.maxLength && this.computation(e.maxLength, S, "creation", [...a, "maxLength"]), e.overflow && this.computation(e.overflow, {
				kind: "enum",
				name: "Overflow"
			}, "creation", [...a, "overflow"]);
			else if (e.kind === "function") {
				this.uniqueNames(e.params.map((e) => e.name), [...a, "params"]), e.params.forEach((e, t) => {
					this.declarations.has(e.name) && this.error("IR_REFERENCE", "A parameter cannot shadow a device member.", [
						...a,
						"params",
						t
					]), e.type.kind !== "pin" && e.type.kind !== "memory" && this.type(e.type, [
						...a,
						"params",
						t,
						"type"
					]);
				}), e.returns && this.type(e.returns, [...a, "returns"]);
				let t = this.context(e.pure ? "pure" : "sync", e.returns);
				t.params = e.params, this.body(e.body, t, [...a, "body"]);
			} else if (e.kind === "start" || e.kind === "on") e.kind === "on" && this.source(e.sourcePath, [...a, "sourcePath"], !0), this.body(e.body, this.context("process"), [...a, "body"]), T(e.body, (e) => {
				if (e.kind === "receive") {
					let t = `${i}`, r = this.receiveOwners.get(e.channel);
					if (r && r !== t) {
						let e = new n([{
							code: "IR_REFERENCE",
							message: "An input channel cannot have multiple consumer processes.",
							phase: "finalize",
							path: a,
							related: []
						}]);
						throw Object.defineProperty(e, "code", { value: "CHANNEL_CONSUMER_CONFLICT" }), e;
					}
					this.receiveOwners.set(e.channel, t);
				}
			});
			else if (e.kind === "reaction") {
				let t = this.source(e.sourcePath, [...a, "sourcePath"], !1);
				this.expect(e.sourceType, t, [...a, "sourceType"]), this.type(e.sourceType, [...a, "sourceType"]);
				let n = [
					e.previous,
					e.current,
					...e.captures.map((e) => e.name)
				];
				e.captures.forEach((e, t) => {
					pe(e.value.type) || this.error("IR_TYPE", "Capture results must be comparable.", [
						...a,
						"captures",
						t
					]), this.computation(e.value, e.value.type, "pure", [
						...a,
						"captures",
						t,
						"value"
					]);
				});
				let r = this.context("reaction");
				r.reaction = e, this.body(e.body, r, [...a, "body"]), this.uniqueNames(n, a);
				for (let e of n) this.declarations.has(e) && this.error("IR_REFERENCE", "Reaction bindings cannot shadow device members.", a);
			} else e.kind === "assert" && this.body(e.body, this.context("creation"), [...a, "body"]);
		}), this.cycle(t, "Creation"), this.cycle(r, "Derived");
	}
	validateBlock(e) {
		e.instructions.forEach((t, n) => {
			let r = this.context("jit");
			r.finalInstruction = n === e.instructions.length - 1, this.body(t.body, r, [
				"instructions",
				n,
				"body"
			]);
		});
	}
};
function Se(e, t) {
	if (!(e instanceof n)) throw e;
	let r = new n(e.diagnostics.map((e) => {
		if (e.source) return e;
		let n = t, r, i = () => {
			let e = n?.source;
			e && typeof e == "object" && (typeof e.label == "string" && e.uri === void 0 && e.range === void 0 || typeof e.uri == "string" && e.range?.start?.line >= 1 && e.range?.start?.column >= 1 && e.range?.end?.line >= 1 && e.range?.end?.column >= 1) && (r = e);
		};
		i();
		for (let t of e.path) n = n?.[t], i();
		return r ? {
			...e,
			source: r
		} : e;
	})), i = Object.getOwnPropertyDescriptor(e, "code");
	throw i?.value === "CHANNEL_CONSUMER_CONFLICT" && Object.defineProperty(r, "code", i), r;
}
var Ce = /* @__PURE__ */ new WeakMap(), we = /* @__PURE__ */ new WeakMap(), Te = /* @__PURE__ */ new WeakMap();
function Ee(e, t) {
	return typeof t == "object" && t ? e.get(t) : void 0;
}
function De(e, t, n) {
	typeof t == "object" && t && e.set(t, n), e.set(n, n);
}
function Oe(t) {
	let n = Ee(Ce, t);
	if (n !== void 0) return n;
	let r = e(t);
	try {
		ie(r);
		let e = new xe(r);
		e.validateDevice();
		let n = r;
		return ye.set(n, e.index), De(Ce, t, n), n;
	} catch (e) {
		return Se(e, r);
	}
}
function ke(t) {
	let n = Ee(we, t);
	if (n !== void 0) return n;
	let r = e(t);
	try {
		ae(r), new xe().validateBlock(r);
		let e = r;
		return De(we, t, e), e;
	} catch (e) {
		return Se(e, r);
	}
}
function Ae(e, t) {
	try {
		let n = ke(e), r = Oe(t);
		if (Te.get(n)?.has(r)) return n;
		new xe(r).validateBlock(n);
		let i = Te.get(n);
		return i || (i = /* @__PURE__ */ new WeakSet(), Te.set(n, i)), i.add(r), n;
	} catch (e) {
		if (e instanceof n) {
			let t = new n(e.diagnostics.map((e) => ({
				...e,
				phase: "bind"
			}))), r = Object.getOwnPropertyDescriptor(e, "code");
			throw r?.value === "CHANNEL_CONSUMER_CONFLICT" && Object.defineProperty(t, "code", r), t;
		}
		throw e;
	}
}
var E = /* @__PURE__ */ new WeakMap(), je = /* @__PURE__ */ new WeakMap(), Me = /* @__PURE__ */ new WeakMap(), Ne = /* @__PURE__ */ new WeakMap(), Pe = /* @__PURE__ */ new WeakMap(), Fe = (e) => {
	let t = Object.freeze({});
	return E.set(t, { type: { kind: e } }), t;
};
function Ie(e, t, n) {
	let r = {};
	for (let i of t) {
		let t = Object.freeze({});
		Pe.set(t, {
			name: e,
			member: i,
			...n ? { owner: n } : {}
		}), Object.defineProperty(r, i, {
			value: t,
			enumerable: !0
		});
	}
	let i = Object.freeze({
		name: e,
		members: Object.freeze(r)
	});
	return E.set(i, {
		type: {
			kind: "enum",
			name: e
		},
		members: Object.freeze([...t]),
		...n ? { owner: n } : {}
	}), i;
}
function Le(e, t, n) {
	let r = Object.freeze({
		name: e,
		fields: Object.freeze({ ...t })
	});
	return E.set(r, {
		type: {
			kind: "record",
			name: e
		},
		fields: r.fields,
		...n ? { owner: n } : {}
	}), r;
}
var Re = {
	number: Fe("number"),
	bool: Fe("bool"),
	string: Fe("string"),
	bytes: Fe("bytes"),
	intent: Fe("intent"),
	sample: Fe("sample"),
	pin: Object.freeze({ kind: "pin" }),
	memory: Object.freeze({ kind: "memory" }),
	logic: Ie("Logic", i.Logic),
	sampleStatus: Ie("SampleStatus", i.SampleStatus),
	overflow: Ie("Overflow", i.Overflow),
	optional(e) {
		let t = E.get(e);
		t && t.type.kind !== "optional" || r("IR_TYPE", "optional requires a nonoptional value type.", [], "construct");
		let n = Object.freeze({});
		return E.set(n, {
			...t,
			type: {
				kind: "optional",
				inner: t.type
			}
		}), n;
	},
	namedEnum(e, t) {
		return typeof e == "string" && Array.isArray(t) && t.length && !t.some((e) => typeof e != "string") && new Set(t).size === t.length || r("IR_TYPE", "Invalid named enum description.", [], "construct"), Ie(e, t);
	},
	namedRecord(e, t) {
		(typeof e != "string" || !t || typeof t != "object" || Array.isArray(t)) && r("IR_TYPE", "Invalid named record description.", [], "construct");
		for (let e of Object.values(t)) ["number", "bool"].includes(E.get(e)?.type.kind ?? "") || r("IR_TYPE", "Record fields must be number or bool types.", [], "construct");
		return Le(e, t);
	}
}, D = Object.freeze(Re), O = { kind: "number" }, k = { kind: "bool" }, ze = { kind: "string" }, Be = { kind: "bytes" }, Ve = { kind: "intent" }, He = { kind: "sample" };
function Ue(e, t) {
	for (let n = e; n; n = n.parent) if (n === t) return !0;
	return !1;
}
function We(e) {
	return typeof e == "object" && e ? je.get(e) : void 0;
}
function Ge(e) {
	return typeof e == "object" && e ? Pe.get(e) : void 0;
}
function Ke(e) {
	return typeof e == "object" && e ? Ne.get(e) : void 0;
}
function qe(e, t) {
	let n = Object.freeze({});
	return e.set(n, t), n;
}
function A(e) {
	return e.alias ? A(e.alias) : e;
}
function Je(e) {
	let t = new Map(e[0]);
	for (let [n, r] of t) e.some((e) => e.get(n) !== r) && t.delete(n);
	return t;
}
var Ye = /* @__PURE__ */ new WeakMap(), Xe = class {
	options;
	device;
	jit;
	closed = !1;
	active;
	source;
	declarations = [];
	ownNames = /* @__PURE__ */ new Map();
	names;
	expectedTypes = /* @__PURE__ */ new Set();
	pending = [];
	instructions = [];
	checkedRegions = /* @__PURE__ */ new WeakSet();
	constructor(t, n, r = !1) {
		this.options = t, this.device = n, this.jit = r, t.source !== void 0 && (this.source = e(t.source));
		let i = n && be(n);
		if (n && (!i || !r)) for (let e of n.declarations) "name" in e && this.ownNames.set(e.name, e);
		if (this.names = (r ? i : void 0) ?? this.ownNames, n && !r) for (let e of n.declarations) this.declarations.push(e);
	}
	error(e, t, n = []) {
		return this.closed = !0, r(e, t, n, "construct", this.active?.source ?? this.source);
	}
	check() {
		this.closed && this.error("IR_LIFECYCLE", "This Builder is closed.");
	}
	guard(e) {
		this.check();
		try {
			return e();
		} catch (e) {
			throw this.closed = !0, e instanceof n && e.diagnostics.some((e) => e.phase !== "construct") ? new n(e.diagnostics.map((e) => ({
				...e,
				phase: "construct"
			}))) : e;
		}
	}
	type(e) {
		let t = E.get(e);
		if (t || this.error("IR_TYPE", "Expected a Builder type descriptor."), t.owner && t.owner !== this && (!this.device || Ye.get(this.device) !== t.owner) && this.error("IR_SCOPE", "Named type belongs to another device definition."), this.expectedTypes.add(t), t.fields) for (let e of Object.values(t.fields)) this.type(e);
		return t.type;
	}
	sourceFor(t) {
		let n = t?.source ?? this.source;
		return n === void 0 ? {} : { source: e(n) };
	}
	body(t, n, r, i, a) {
		let o = new Ze(this, t, {
			result: 0,
			local: 0
		}, {}, void 0, r);
		o.source = i === void 0 ? this.source : e(i);
		let s = this.active;
		this.active = o;
		try {
			a?.(o), n(o.view());
		} finally {
			o.closed = !0, this.active = s;
		}
		return this.check(), {
			operations: o.operations,
			...o.source ? { source: e(o.source) } : {}
		};
	}
	creation(e, t, n = "creation", r) {
		return {
			type: e,
			body: this.body(n, (e) => {
				typeof t == "function" ? t(e) : e.returnValue(t);
			}, e, r)
		};
	}
	declarationType(e) {
		let t = this.names.get(e);
		return t && "type" in t ? t.type : void 0;
	}
	add(e) {
		e.name !== void 0 && (this.names.has(e.name) && this.error("IR_REFERENCE", `Duplicate declaration ${e.name}.`), this.ownNames.set(e.name, e)), e.kind === "start" && this.declarations.some((e) => e.kind === "start") && this.error("IR_REFERENCE", "Only one start process is allowed."), this.declarations.push(e);
	}
	resolve() {
		for (let e of this.pending) {
			let t = this.names.get(e.call);
			if (!t || t.kind !== "function") {
				this.jit && e.requiresSignature && r("IR_TYPE", "A null or record call argument requires a bound function signature or an explicitly typed Value.");
				continue;
			}
			let n = t.params[e.index];
			if (n && n.type.kind !== "pin" && n.type.kind !== "memory" || this.error("IR_TYPE", "A value argument requires a value parameter."), n.type.kind === "optional" && e.value !== null) {
				let t = e.body.constantData(n.type.inner, e.value), i = e.body.space.result++, a = {
					kind: "constant",
					result: i,
					type: n.type.inner,
					constant: t,
					...e.node.source ? { source: e.node.source } : {}
				}, o = (t) => {
					if (Array.isArray(t)) {
						let n = t.indexOf(e.node);
						return n >= 0 ? (t.splice(n, 0, a), !0) : t.some(o);
					}
					return typeof t == "object" && !!t && Object.values(t).some(o);
				};
				o(this.jit ? this.instructions : this.declarations) || r("IR_SCHEMA", "Pending call argument is not part of this definition."), delete e.node.constant, Object.assign(e.node, {
					kind: "optional",
					type: n.type,
					value: i
				});
			} else {
				let t = e.body.constantData(n.type, e.value);
				Object.assign(e.node, {
					type: n.type,
					constant: t
				});
			}
		}
		for (let e of this.expectedTypes) {
			let t = e.type.kind === "optional" ? e.type.inner : e.type;
			if (!["enum", "record"].includes(t.kind)) continue;
			let n = t.name, a = this.names.get(n);
			if (i[n] && t.kind === "enum") e.members && (e.members.length !== i[n].length || e.members.some((e, t) => e !== i[n][t])) && r("IR_TYPE", "Builtin enum description does not match its members.");
			else if (a && (a.kind !== t.kind && r("IR_REFERENCE", "Named type category does not match its declaration."), e.members && (e.members.length !== a.members.length || e.members.some((e, t) => e !== a.members[t])) && r("IR_TYPE", "Forward enum description does not match its declaration."), e.fields)) {
				let t = Object.entries(e.fields);
				(t.length !== a.fields.length || t.some(([e, t]) => !a.fields.some((n) => n.name === e && n.type === E.get(t)?.type.kind))) && r("IR_TYPE", "Forward record description does not match its declaration.");
			}
		}
	}
}, Ze = class t {
	root;
	mode;
	space;
	scope;
	parent;
	returns;
	closed = !1;
	ended = !1;
	endedByWaitUntil = !1;
	source;
	operations = [];
	facts = /* @__PURE__ */ new Map();
	localValues = /* @__PURE__ */ new Map();
	loop = 0;
	calculate = !1;
	yielded = !1;
	constructor(e, t, n, r, i, a) {
		this.root = e, this.mode = t, this.space = n, this.scope = r, this.parent = i, this.returns = a;
	}
	view() {
		return new Proxy(Object.create(null), { get: (e, t) => typeof t == "string" ? (...e) => this.root.guard(() => (this.closed && this.root.error("IR_LIFECYCLE", "This body Builder is closed."), this.root.active !== this && this.root.error("IR_SCOPE", "A captured outer Builder cannot emit into a nested callback."), this.ended && this.root.error(this.endedByWaitUntil ? "IR_JIT_BOUNDARY" : "IR_CONTROL_FLOW", "Cannot append an operation after a path terminator."), this.invoke(t, e))) : void 0 });
	}
	node(t) {
		let n = {
			...t,
			...t.source === void 0 && this.source !== void 0 ? { source: e(this.source) } : {}
		};
		re(n, [], this.root.checkedRegions), this.operations.push(n);
	}
	result(e, t, n = {}) {
		let r = this.space.result++;
		return this.node({
			...t,
			result: r,
			type: e
		}), qe(je, {
			root: this.root,
			scope: this.scope,
			space: this.space,
			type: e,
			id: r,
			...n
		});
	}
	handle(e, t) {
		let n = We(e);
		return n && n.root === this.root && n.space === this.space && Ue(this.scope, n.scope) || this.root.error("IR_SCOPE", "Value is not visible in the current execution body or scope."), t && !de(n.type, t) && this.root.error("IR_TYPE", "Operand type does not match the expected type."), n;
	}
	localHandle(e) {
		let t = Me.get(e);
		return t && t.root === this.root && t.space === this.space && Ue(this.scope, t.scope) || this.root.error("IR_SCOPE", "Local is not visible in this execution body or scope."), t;
	}
	infer(e) {
		if (We(e)) return this.handle(e).type;
		let t = Ge(e);
		if (t) return t.owner && t.owner !== this.root && (!this.root.device || Ye.get(this.root.device) !== t.owner) && this.root.error("IR_SCOPE", "Enum member belongs to another device definition."), {
			kind: "enum",
			name: t.name
		};
		if (typeof e == "number") return O;
		if (typeof e == "boolean") return k;
		if (typeof e == "string") return ze;
		if (Array.isArray(e) || e instanceof Uint8Array) return Be;
		this.root.error("IR_TYPE", "A null or record literal requires an explicit target type.");
	}
	constantData(e, t) {
		if (e.kind === "optional") return t !== null && this.root.error("IR_TYPE", "Optional constants must be lifted from a non-null value."), { kind: "none" };
		if (e.kind === "number" || e.kind === "bool" || e.kind === "string") return typeof t !== (e.kind === "bool" ? "boolean" : e.kind) && this.root.error("IR_TYPE", "Constant value does not match its target type."), {
			kind: e.kind,
			value: t
		};
		if (e.kind === "enum") {
			let n = Ge(t);
			return n && n.name === e.name || this.root.error("IR_TYPE", "Enum constants require a matching enum member token."), n.owner && n.owner !== this.root && (!this.root.device || Ye.get(this.root.device) !== n.owner) && this.root.error("IR_SCOPE", "Enum member belongs to another definition."), {
				kind: "enum",
				name: n.name,
				member: n.member
			};
		}
		if (e.kind === "record") {
			(typeof t != "object" || !t || Array.isArray(t)) && this.root.error("IR_TYPE", "A record constant requires a field object.");
			let n = [...this.root.expectedTypes].find((t) => {
				let n = t.type.kind === "optional" ? t.type.inner : t.type;
				return n.kind === "record" && n.name === e.name && t.fields;
			}), r = this.root.names.get(e.name), i = n?.fields ? Object.entries(n.fields).map(([e, t]) => ({
				name: e,
				type: E.get(t).type.kind
			})) : r?.kind === "record" ? r.fields : void 0;
			i || this.root.error("IR_TYPE", "Record constants require a complete named type descriptor.");
			let a = t;
			return (Object.keys(a).length !== i.length || i.some((e) => !Object.hasOwn(a, e.name) || typeof a[e.name] != (e.type === "bool" ? "boolean" : "number"))) && this.root.error("IR_TYPE", "Record constant fields do not match the target type."), {
				kind: "record",
				name: e.name,
				fields: Object.keys(a).map((e) => ({
					name: e,
					value: a[e]
				}))
			};
		}
		if (e.kind === "bytes") {
			!(t instanceof Uint8Array) && !Array.isArray(t) && this.root.error("IR_TYPE", "bytes constants require a Uint8Array or number array.");
			let e = Array.from(t);
			return e.some((e) => !Number.isInteger(e) || e < 0 || e > 255) && this.root.error("IR_TYPE", "Every bytes element must be an integer from zero to 255."), {
				kind: "bytes",
				value: Object.freeze(e)
			};
		}
		this.root.error("IR_TYPE", "sample and intent cannot be constructed from host constants.");
	}
	operand(e, t) {
		if (We(e)) {
			let n = this.handle(e);
			if (t && t.kind === "optional" && de(n.type, t.inner)) {
				let e = this.handle(this.result(t, {
					kind: "optional",
					value: n.id
				}));
				return this.facts.set(A(e), !0), e;
			}
			return t && !de(n.type, t) && this.root.error("IR_TYPE", "Operand type does not match the expected type."), n;
		}
		let n = t ?? this.infer(e);
		if (n.kind === "optional" && e !== null) {
			let t = this.operand(e, n.inner), r = this.handle(this.result(n, {
				kind: "optional",
				value: t.id
			}));
			return this.facts.set(A(r), !0), r;
		}
		return this.handle(this.result(n, {
			kind: "constant",
			constant: this.constantData(n, e)
		}, { none: e === null }));
	}
	ref(e, t) {
		if (typeof e == "string") return {
			kind: t,
			name: e
		};
		let n = Ke(e);
		return n && n.root === this.root && n.space === this.space && Ue(this.scope, n.scope) || this.root.error("IR_SCOPE", "Resource reference is not visible in this body."), (n.ref.kind === "parameter" ? n.ref.resource : n.ref.kind) !== t && this.root.error("IR_REFERENCE", "Resource reference category does not match."), n.ref;
	}
	refHandle(e, t) {
		return qe(Ne, {
			root: this.root,
			scope: this.scope,
			space: this.space,
			ref: {
				kind: t,
				name: e
			}
		});
	}
	requireRead() {
		["creation", "initial"].includes(this.mode) && this.root.error("IR_EFFECT", "Runtime resource reads are not available in creation code.");
	}
	requireEffect() {
		[
			"creation",
			"initial",
			"pure"
		].includes(this.mode) && this.root.error("IR_EFFECT", "Runtime effects are not available in pure or creation code.");
	}
	branch(n, r, i, a = !1) {
		typeof n != "function" && this.root.error("IR_SCHEMA", "A body callback is required.");
		let o = new t(this.root, this.mode, this.space, { parent: this.scope }, this, this.returns);
		if (o.source = this.source, o.loop = i ? 0 : this.loop + +!!a, o.calculate = !!i || this.calculate, o.facts = new Map(this.facts), o.localValues = new Map(this.localValues), r) for (let [e, t] of (r.truth ? r.info.yes : r.info.no) ?? []) o.facts.set(A(e), t);
		let s = this.root.active;
		this.root.active = o;
		let c;
		try {
			if (c = n(o.view()), i) {
				if (c === void 0) o.ended || this.root.error("IR_CONTROL_FLOW", "A compute callback must produce a value on every normal path.");
				else if (!o.ended) {
					let e = o.operand(c, i);
					o.node({
						kind: "yield",
						value: e.id
					}), o.yielded = !0, o.ended = !0;
				}
			}
		} finally {
			o.closed = !0, this.root.active = s;
		}
		this.root.check();
		let l = {
			operations: o.operations,
			...o.source ? { source: e(o.source) } : {}
		};
		return this.root.checkedRegions.add(l), {
			body: l,
			builder: o,
			returned: c
		};
	}
	merge(e) {
		let t = e.filter((e) => !e.ended);
		if (!t.length) this.ended = !0, this.endedByWaitUntil = e.some((e) => e.endedByWaitUntil);
		else {
			this.facts = Je(t.map((e) => e.facts));
			for (let [e, n] of this.localValues) {
				let r = t.map((t) => t.localValues.get(e) ?? n);
				if (r.every((e) => e === r[0])) this.localValues.set(e, r[0]);
				else {
					let i = {
						...n,
						alias: void 0
					};
					this.localValues.set(e, i), r.every((e, n) => t[n].facts.get(A(e)) === !0) && this.facts.set(i, !0);
				}
			}
		}
	}
	mergeComputations(e, t = !1) {
		let n = e.filter((e) => e.yielded);
		if (t && n.push(this), !n.length) this.ended = !0;
		else {
			this.facts = Je(n.map((e) => e.facts));
			for (let [e, t] of this.localValues) {
				let r = n.map((n) => n.localValues.get(e) ?? t);
				if (r.every((e) => e === r[0])) this.localValues.set(e, r[0]);
				else {
					let i = {
						...t,
						alias: void 0
					};
					this.localValues.set(e, i), r.every((e, t) => n[t].facts.get(A(e)) === !0) && this.facts.set(i, !0);
				}
			}
		}
	}
	invoke(n, r) {
		if (a.includes(n)) {
			let e = this.operand(r[0], n === "not" ? k : O);
			return this.result(n === "not" ? k : O, {
				kind: "unary",
				operator: n,
				value: e.id
			}, n === "not" ? {
				yes: e.no ?? /* @__PURE__ */ new Map(),
				no: e.yes ?? /* @__PURE__ */ new Map()
			} : {});
		}
		if (o.includes(n)) {
			let e = ["equal", "notEqual"].includes(n), t = e ? this.root.type(r.shift()) : n === "concat" ? ze : O, i = this.operand(r[0], t), a = this.operand(r[1], t);
			e && (t.kind === "intent" || t.kind === "optional" && t.inner.kind === "intent" && !i.none && !a.none) && this.root.error("IR_TYPE", "Intent values do not support content equality.");
			let o = i.none ? a : a.none ? i : void 0, s = e || [
				"lessThan",
				"lessThanOrEqual",
				"greaterThan",
				"greaterThanOrEqual"
			].includes(n);
			return this.result(s ? k : t, {
				kind: "binary",
				operator: n,
				left: i.id,
				right: a.id
			}, o ? {
				yes: /* @__PURE__ */ new Map([[A(o), n !== "equal"]]),
				no: /* @__PURE__ */ new Map([[A(o), n === "equal"]])
			} : {});
		}
		if (s.includes(n)) {
			let e = [
				"min",
				"max",
				"pow"
			].includes(n) ? 2 : 1;
			return r.length !== e && this.root.error("IR_TYPE", "Numeric builtin argument count does not match."), this.result(n.startsWith("is") ? k : O, {
				kind: "numeric",
				builtin: n,
				args: r.map((e) => this.operand(e, O).id)
			});
		}
		if (c.includes(n) || l.includes(n)) {
			this.requireRead();
			let e = this.ref(r[0], "memory"), t = this.operand(r[1], O);
			if (l.includes(n)) {
				this.requireEffect(), this.node({
					kind: n,
					memory: e,
					offset: t.id,
					value: this.operand(r[2], O).id
				});
				return;
			}
			return this.result(O, {
				kind: n,
				memory: e,
				offset: t.id
			});
		}
		switch (n) {
			case "withSource": {
				let [n, i] = r, a = new t(this.root, this.mode, this.space, this.scope, this.parent, this.returns);
				a.source = e(n), a.loop = this.loop, a.calculate = this.calculate, a.facts = this.facts, a.localValues = this.localValues;
				let o = this.root.active;
				this.root.active = a;
				try {
					i(a.view());
				} finally {
					a.closed = !0, this.root.active = o;
				}
				this.operations.push(...a.operations), this.ended = a.ended, this.endedByWaitUntil = a.endedByWaitUntil, this.facts = a.facts, this.localValues = a.localValues;
				return;
			}
			case "constant": return We(r[1]) && this.root.error("IR_TYPE", "constant requires a host constant, not a Value handle."), this.objectOperand(r[1], this.root.type(r[0]));
			case "readProperty":
			case "readConst":
			case "readState":
			case "readDerived": {
				["readState", "readDerived"].includes(n) && this.requireRead();
				let e = n.slice(4).toLowerCase();
				return this.result(this.root.type(r[1]), {
					kind: "read",
					resource: e,
					name: r[0]
				});
			}
			case "local": {
				let e = this.root.type(r[0]), t = this.operand(r[1], e), n = this.space.local++;
				this.node({
					kind: "local",
					local: n,
					type: e,
					initial: t.id
				});
				let i = {
					root: this.root,
					space: this.space,
					scope: this.scope,
					type: e,
					id: n
				};
				return this.localValues.set(i, t), qe(Me, i);
			}
			case "getLocal": {
				let e = this.localHandle(r[0]), t = this.localValues.get(e);
				return this.result(e.type, {
					kind: "localRead",
					local: e.id
				}, {
					alias: A(t),
					yes: t.yes ?? /* @__PURE__ */ new Map(),
					no: t.no ?? /* @__PURE__ */ new Map(),
					none: t.none ?? !1
				});
			}
			case "setLocal": {
				let e = this.localHandle(r[0]), t = this.operand(r[1], e.type);
				this.node({
					kind: "localWrite",
					local: e.id,
					value: t.id
				}), this.localValues.set(e, t);
				return;
			}
			case "record": {
				let e = this.root.type(r[0]), t = E.get(r[0]), n = r[1];
				return e.kind === "record" && t.fields && n && typeof n == "object" && Object.keys(n).length === Object.keys(t.fields).length && !Object.keys(t.fields).some((e) => !Object.hasOwn(n, e)) || this.root.error("IR_TYPE", "Record fields must exactly match the descriptor."), this.result(e, {
					kind: "record",
					fields: Object.keys(n).map((e) => ({
						name: e,
						value: this.operand(n[e], this.root.type(t.fields[e])).id
					}))
				});
			}
			case "field": {
				let e = this.handle(r[0]), t = r[1], n;
				if (e.type.kind === "sample") n = {
					voltage: {
						kind: "optional",
						inner: O
					},
					level: {
						kind: "enum",
						name: "Logic"
					},
					status: {
						kind: "enum",
						name: "SampleStatus"
					}
				}[t];
				else if (e.type.kind === "record") {
					let r = e.type.name, i = [...this.root.expectedTypes].find((e) => {
						let t = e.type.kind === "optional" ? e.type.inner : e.type;
						return t.kind === "record" && t.name === r && e.fields;
					})?.fields?.[t];
					if (i) n = this.root.type(i);
					else {
						let e = this.root.names.get(r), i = e?.kind === "record" ? e.fields.find((e) => e.name === t) : void 0;
						i && (n = { kind: i.type });
					}
				}
				n || this.root.error("IR_REFERENCE", "Unknown record or sample field.");
				let i = A(e);
				i.fields ??= /* @__PURE__ */ new Map();
				let a = i.fields.get(t), o = this.result(n, {
					kind: "field",
					value: e.id,
					field: t
				}, a ? { alias: a } : {});
				return a || i.fields.set(t, this.handle(o)), o;
			}
			case "bytes": return this.result(Be, {
				kind: "bytes",
				elements: r.map((e) => this.operand(e, O).id)
			});
			case "length": {
				let e = this.handle(r[0]);
				return ["string", "bytes"].includes(e.type.kind) || this.root.error("IR_TYPE", "length requires string or bytes."), this.result(O, {
					kind: "length",
					value: e.id
				});
			}
			case "index": {
				let e = this.handle(r[0]);
				return ["string", "bytes"].includes(e.type.kind) || this.root.error("IR_TYPE", "index requires string or bytes."), this.result(e.type.kind === "string" ? ze : O, {
					kind: "index",
					value: e.id,
					index: this.operand(r[1], O).id
				});
			}
			case "optional": {
				let e = this.handle(r[0]);
				e.type.kind === "optional" && this.root.error("IR_TYPE", "Optional types cannot be nested.");
				let t = this.result({
					kind: "optional",
					inner: e.type
				}, {
					kind: "optional",
					value: e.id
				});
				return this.facts.set(A(this.handle(t)), !0), t;
			}
			case "isNone": {
				let e = this.handle(r[0]);
				return e.type.kind !== "optional" && this.root.error("IR_TYPE", "isNone requires an optional value."), this.result(k, {
					kind: "isNone",
					value: e.id
				}, {
					yes: /* @__PURE__ */ new Map([[A(e), !1]]),
					no: /* @__PURE__ */ new Map([[A(e), !0]])
				});
			}
			case "nonNull": {
				let e = this.handle(r[0]);
				return (e.type.kind !== "optional" || this.facts.get(A(e)) !== !0) && this.root.error("IR_TYPE", "nonNull requires a dominating non-null proof."), this.result(e.type.inner, {
					kind: "nonNull",
					value: e.id
				});
			}
			case "pin": return this.mode === "creation" && this.root.error("IR_EFFECT", "Pin references are not available in ordinary creation computations."), this.refHandle(r[0], "pin");
			case "memory": return this.requireRead(), this.refHandle(r[0], "memory");
			case "memoryLength": return this.requireRead(), this.result(O, {
				kind: "memoryLength",
				memory: this.ref(r[0], "memory")
			});
			case "copyBytes": return this.requireRead(), this.result(Be, {
				kind: "copyBytes",
				memory: this.ref(r[0], "memory"),
				offset: this.operand(r[1], O).id,
				length: this.operand(r[2], O).id
			});
			case "readSample": return this.requireRead(), this.result(He, {
				kind: "readSample",
				pin: this.ref(r[0], "pin")
			});
			case "resistor": return this.mode === "creation" && this.root.error("IR_EFFECT", "Intent construction requires initial-intent or runtime code."), this.result(Ve, {
				kind: "resistor",
				to: this.ref(r[0], "pin"),
				resistance: this.operand(r[1], O).id
			});
			case "combineIntents": return this.mode === "creation" && this.root.error("IR_EFFECT", "Intent construction is not available here."), this.result(Ve, {
				kind: "combineIntents",
				values: r.map((e) => this.operand(e, Ve).id)
			});
			case "refEqual": {
				this.requireRead();
				let e = Ke(r[0]), t = Ke(r[1]);
				e && t || this.root.error("IR_TYPE", "refEqual requires resource reference handles.");
				let n = e.ref.kind === "parameter" ? e.ref.resource : e.ref.kind;
				return this.result(k, {
					kind: "refEqual",
					left: this.ref(r[0], n),
					right: this.ref(r[1], n)
				});
			}
			case "writeState":
				this.requireEffect(), this.node({
					kind: "write",
					resource: "state",
					name: r[0],
					value: this.operand(r[1], this.root.declarationType(r[0])).id
				});
				return;
			case "writeIntent":
				this.requireEffect(), this.node({
					kind: "writeIntent",
					pin: this.ref(r[0], "pin"),
					value: this.operand(r[1], Ve).id
				});
				return;
			case "send":
				this.requireEffect(), this.node({
					kind: "send",
					channel: r[0],
					value: this.operand(r[1], this.root.declarationType(r[0])).id
				});
				return;
			case "notify":
				this.requireEffect(), this.node({
					kind: "notify",
					notification: r[0]
				});
				return;
			case "now":
			case "random": return this.requireEffect(), this.result(O, { kind: n });
			case "call":
			case "callValue":
			case "callPure":
			case "callPureValue": {
				let t = n.startsWith("callPure"), i = n.endsWith("Value");
				t || this.requireEffect();
				let a = r.shift(), o = i ? this.root.type(r.shift()) : void 0, s = this.root.names.get(a), c = s?.kind === "function" ? s.params : void 0, l = r.map((t, n) => {
					let r = Ke(t);
					if (r) return this.mode === "creation" && this.root.error("IR_EFFECT", "Resource arguments are not available in ordinary creation code."), this.ref(t, r.ref.kind === "parameter" ? r.ref.resource : r.ref.kind);
					let i = c?.[n]?.type;
					if (i && ["pin", "memory"].includes(i.kind) && this.root.error("IR_TYPE", "A resource reference argument is required."), !i && !We(t)) {
						let r = t === null || typeof t == "object" && !Ge(t) && !Array.isArray(t) && !(t instanceof Uint8Array), i = r ? O : this.infer(t), o = {
							kind: "constant",
							result: this.space.result++,
							type: i,
							constant: r ? {
								kind: "number",
								value: 0
							} : this.constantData(i, t),
							...this.source ? { source: e(this.source) } : {}
						};
						return re(o, []), this.operations.push(o), this.root.pending.push({
							node: o,
							call: a,
							index: n,
							value: Ge(t) ? t : e(t),
							body: this,
							requiresSignature: r
						}), {
							kind: "value",
							value: o.result
						};
					}
					return {
						kind: "value",
						value: this.operand(t, i).id
					};
				}), u = {
					kind: i ? "callValue" : "call",
					name: a,
					pure: t,
					args: l
				};
				if (i) return this.result(o, u);
				this.node(u);
				return;
			}
			case "receive": return (this.calculate || this.mode !== "process") && this.root.error("IR_EFFECT", "receive requires a process statement region."), this.result(this.root.type(r[1]), {
				kind: "receive",
				channel: r[0]
			});
			case "if": {
				let e = this.operand(r[0], k), t = this.branch(r[1], {
					info: e,
					truth: !0
				}), n = this.branch(r[2] ?? (() => {}), {
					info: e,
					truth: !1
				});
				this.node({
					kind: "if",
					condition: e.id,
					yes: t.body,
					...r[2] ? { no: n.body } : {}
				}), this.merge([t.builder, n.builder]);
				return;
			}
			case "match": {
				let e = this.handle(r[0]), t = r[1];
				Array.isArray(t) || this.root.error("IR_SCHEMA", "match arms must be an array.");
				let n = [], i = t.map((t) => {
					let r = t.pattern === null ? { kind: "none" } : this.constantData(e.type.kind === "optional" ? e.type.inner : e.type, t.pattern);
					[
						"none",
						"number",
						"bool",
						"string",
						"enum"
					].includes(r.kind) || this.root.error("IR_TYPE", "Invalid match pattern.");
					let i = {
						...e,
						yes: /* @__PURE__ */ new Map([[A(e), r.kind !== "none"]])
					}, a = this.branch(t.emit, {
						info: i,
						truth: !0
					});
					return n.push(a.builder), {
						pattern: r,
						body: a.body
					};
				}), a = i.some((e) => e.pattern.kind === "none") ? {
					info: {
						...e,
						yes: /* @__PURE__ */ new Map([[A(e), !0]])
					},
					truth: !0
				} : void 0, o = r[2] ? this.branch(r[2], a) : void 0;
				o && n.push(o.builder), this.node({
					kind: "match",
					value: e.id,
					arms: i,
					...o ? { otherwise: o.body } : {}
				}), this.merge(n.length ? n : [this]);
				return;
			}
			case "while":
			case "loop": {
				let e = new Map(this.localValues), t = n === "while" ? this.branch(r[0], void 0, k) : void 0, i = this.branch(r[+(n === "while")], void 0, void 0, !0);
				this.node({
					kind: n,
					...t ? { test: {
						type: k,
						body: t.body
					} } : {},
					body: i.body
				});
				for (let [n, r] of e) (i.builder.localValues.get(n) !== r || t && t.builder.localValues.get(n) !== r) && this.localValues.set(n, {
					...r,
					alias: void 0
				});
				t && !t.builder.yielded && (this.ended = !0);
				return;
			}
			case "and":
			case "or": {
				let e = this.operand(r[0], k), t = n === "and", i = this.branch(r[1], {
					info: e,
					truth: t
				}, k), a = We(i.returned), o = (e, t) => new Map([...e ?? [], ...t ?? []]), s = t ? o(e.yes, a?.yes) : Je([e.yes ?? /* @__PURE__ */ new Map(), o(e.no, a?.yes)]), c = t ? Je([e.no ?? /* @__PURE__ */ new Map(), o(e.yes, a?.no)]) : o(e.no, a?.no), l = this.result(k, {
					kind: n,
					left: e.id,
					right: {
						type: k,
						body: i.body
					}
				}, {
					yes: s,
					no: c
				});
				return this.mergeComputations([i.builder], !0), l;
			}
			case "select": {
				let e = this.root.type(r[0]), t = this.operand(r[1], k), n = this.branch(r[2], {
					info: t,
					truth: !0
				}, e), i = this.branch(r[3], {
					info: t,
					truth: !1
				}, e), a = this.result(e, {
					kind: "select",
					condition: t.id,
					yes: {
						type: e,
						body: n.body
					},
					no: {
						type: e,
						body: i.body
					}
				});
				return this.mergeComputations([n.builder, i.builder]), a;
			}
			case "assert": {
				let e = this.operand(r[0], k), t = r[1] ? this.branch(r[1], {
					info: e,
					truth: !1
				}, ze) : void 0;
				this.node({
					kind: "assert",
					condition: e.id,
					...t ? { message: {
						type: ze,
						body: t.body
					} } : {}
				});
				for (let [t, n] of e.yes ?? []) this.facts.set(A(t), n);
				return;
			}
			case "wait":
			case "elapse":
				(this.calculate || (n === "wait" ? this.mode !== "process" : this.mode !== "jit")) && this.root.error("IR_EFFECT", `${n} is not permitted in this context.`), this.node({
					kind: n,
					duration: this.operand(r[0], O).id
				});
				return;
			case "waitUntil":
				(this.mode !== "jit" || this.calculate || this.loop) && this.root.error("IR_JIT_BOUNDARY", "waitUntil requires a JIT tail path outside loops and computations."), this.node({
					kind: "waitUntil",
					predicate: r[0]
				}), this.ended = !0, this.endedByWaitUntil = !0;
				return;
			case "redirect":
				["jit", "sync"].includes(this.mode) || this.root.error("IR_EFFECT", "redirect requires a JIT-capable context."), this.node({
					kind: "redirect",
					target: this.operand(r[0], O).id,
					delay: this.operand(r[1] ?? 0, O).id
				}), this.ended = !0;
				return;
			case "stop":
				(this.mode !== "jit" || this.calculate) && this.root.error("IR_EFFECT", "stop requires a JIT statement region."), this.node({ kind: "stop" }), this.ended = !0;
				return;
			case "break":
			case "continue":
				this.loop || this.root.error("IR_CONTROL_FLOW", `${n} requires an enclosing loop.`), this.node({ kind: n }), this.ended = !0;
				return;
			case "return":
				(this.calculate || this.returns || [
					"jit",
					"creation",
					"initial"
				].includes(this.mode)) && this.root.error("IR_CONTROL_FLOW", "Void return is not permitted in this body."), this.node({ kind: "return" }), this.ended = !0;
				return;
			case "returnValue":
				(this.calculate || !this.returns) && this.root.error("IR_CONTROL_FLOW", "returnValue is not permitted in this body."), this.node({
					kind: "returnValue",
					value: this.operand(r[0], this.returns).id
				}), this.ended = !0;
				return;
			default: this.root.error("IR_SCHEMA", `Unknown Builder operation ${n}.`);
		}
	}
	objectOperand(e, t) {
		return qe(je, this.operand(e, t));
	}
};
function Qe(t = {}) {
	let n = new Xe({
		name: "JitBlock",
		...t.source ? { source: t.source } : {}
	}, t.device, !0), r = (i = { closed: !1 }) => new Proxy(Object.create(null), { get: (a, o) => typeof o == "string" ? (...a) => {
		if (o === "finish") {
			n.check(), i.closed && n.error("IR_LIFECYCLE", "This source view is closed."), n.active && n.error("IR_SCOPE", "Cannot finish a block inside an instruction callback."), n.closed = !0, n.resolve();
			let e = {
				kind: "block",
				instructions: n.instructions,
				...n.sourceFor()
			};
			return t.device ? Ae(e, t.device) : ke(e);
		}
		return n.guard(() => {
			if (i.closed && n.error("IR_LIFECYCLE", "This source view is closed."), n.active && n.error("IR_SCOPE", "Cannot add instructions inside an instruction callback."), o === "withSource") {
				let t = n.source, i = { closed: !1 };
				n.source = e(a[0]);
				try {
					a[1](r(i));
				} finally {
					i.closed = !0, n.source = t;
				}
				return;
			}
			o !== "instruction" && n.error("IR_SCHEMA", `Unknown block Builder method ${o}.`);
			let t = a[0];
			t && Number.isFinite(t.pc) && Number.isFinite(t.nextPc) || n.error("IR_SCHEMA", "Instruction boundaries require finite pc and nextPc.");
			let s = n.instructions.at(-1);
			s && s.nextPc !== t.pc && n.error("IR_JIT_BOUNDARY", "Adjacent instruction boundaries must match.");
			let c = n.body("jit", a[1], void 0, t.source ?? n.source);
			n.instructions.push({
				pc: t.pc,
				nextPc: t.nextPc,
				body: c,
				...n.sourceFor(t)
			});
		});
	} : void 0 });
	return r();
}
// ../../devices/iap15f2k61s2/src/kernel/machine.ts
var $e;
function et(e, t) {
	let n = $e;
	$e = e;
	try {
		return t();
	} finally {
		$e = n;
	}
}
function j() {
	if ($e === void 0) throw Error("iap15f2k61s2: 在 translate 之外访问器件翻译上下文");
	return $e;
}
// ../../devices/iap15f2k61s2/src/kernel/ir.ts
var tt = (e) => e, nt = "code", M = "iram", rt = "xram", N = "periph", it = "clockPs", P = 65535, at = 1791, ot = /* @__PURE__ */ new WeakMap(), st = /* @__PURE__ */ new WeakMap(), F = (e, t) => {
	let n = ot.get(e);
	n === void 0 && (n = /* @__PURE__ */ new Map(), ot.set(e, n));
	let r = Object.is(t, -0) ? "-0" : String(t), i = n.get(r);
	return i === void 0 && (i = e.constant(D.number, t), n.set(r, i)), i;
}, I = (e, t) => {
	let n = st.get(e);
	n === void 0 && (n = /* @__PURE__ */ new Map(), st.set(e, n));
	let r = n.get(t);
	return r === void 0 && (r = e.constant(D.bool, t), n.set(t, r)), r;
}, L = (e, t) => e.bitAnd(typeof t == "number" ? F(e, t) : t, F(e, 255)), R = (e, t) => (j().noteSfrRead(t), j().sfr.read(e, t)), z = (e, t, n) => {
	j().noteSfrWrite(t), j().sfr.write(e, t & 255, n);
}, ct = (e, t) => (j().noteSfrRead(t), e.load8("sfr", F(e, t & 127))), lt = (e, t, n) => e.bitAnd(e.shiftRightUnsigned(R(e, t), F(e, n)), F(e, 1)), ut = (e, t, n) => e.equal(D.number, lt(e, t, n), F(e, 1)), B = (e, t) => t < 128 ? e.load8(M, F(e, t)) : ct(e, t), V = (e) => R(e, 224), H = (e) => R(e, 208), dt = (e, t) => {
	let n = t;
	return n = e.bitXor(n, e.shiftRightUnsigned(n, F(e, 4))), n = e.bitXor(n, e.shiftRightUnsigned(n, F(e, 2))), n = e.bitXor(n, e.shiftRightUnsigned(n, F(e, 1))), e.bitAnd(n, F(e, 1));
}, U = (e, t) => {
	let n = L(e, t);
	z(e, 224, n), z(e, 208, e.bitOr(e.bitAnd(H(e), F(e, 254)), dt(e, n)));
}, W = (e) => e.equal(D.number, e.bitAnd(H(e), F(e, 128)), F(e, 128)), ft = (e) => e.bitAnd(e.shiftRightUnsigned(H(e), F(e, 7)), F(e, 1)), G = (e, t) => {
	let n = H(e), r = e.bitOr(n, F(e, 128)), i = e.bitAnd(n, F(e, 127));
	z(e, 208, e.select(D.number, t, () => r, () => i));
}, pt = (e, t, n, r) => {
	let i = e.bitAnd(H(e), F(e, 57)), a = F(e, 0), o = F(e, 128), s = F(e, 64), c = F(e, 4), l = e.bitOr(i, e.select(D.number, t, () => o, () => a)), u = e.bitOr(l, e.select(D.number, n, () => s, () => a));
	z(e, 208, e.bitOr(u, e.select(D.number, r, () => c, () => a)));
}, mt = (e) => e.bitOr(e.shiftLeft(R(e, 131), F(e, 8)), R(e, 130)), ht = (e, t) => {
	z(e, 130, e.bitAnd(t, F(e, 255))), z(e, 131, e.bitAnd(e.shiftRightUnsigned(t, F(e, 8)), F(e, 255)));
}, gt = (e, t) => e.bitOr(e.bitAnd(H(e), F(e, 24)), F(e, t)), _t = (e, t) => e.load8(M, gt(e, t)), K = (e, t) => e.load8(M, gt(e, t)), q = (e, t, n) => {
	e.store8(M, gt(e, t), L(e, n));
}, J = (e, t) => e.load8(M, _t(e, t)), vt = (e, t, n) => {
	e.store8(M, _t(e, t), L(e, n));
}, yt = /* @__PURE__ */ new Map([
	[128, 0],
	[144, 1],
	[160, 2],
	[176, 3],
	[192, 4]
]), Y = (e, t) => {
	if (t < 128) return e.load8(M, F(e, t));
	let n = yt.get(t);
	return n === void 0 ? R(e, t) : j().ports.readPort(e, n);
}, X = (e, t, n) => {
	t < 128 ? e.store8(M, F(e, t), L(e, n)) : z(e, t, n);
}, bt = (e) => e < 128 ? 32 + (e >> 3) : e & 248, xt = (e, t) => {
	let n = bt(t), r = t & 7, i = yt.get(n);
	return i === void 0 ? e.bitAnd(e.shiftRightUnsigned(Y(e, n), F(e, r)), F(e, 1)) : j().ports.readPin(e, i, r);
}, St = (e, t) => e.equal(D.number, xt(e, t), F(e, 1)), Ct = (e, t) => e.equal(D.number, e.bitAnd(e.shiftRightUnsigned(B(e, bt(t)), F(e, t & 7)), F(e, 1)), F(e, 1)), wt = (e, t, n) => {
	let r = bt(t), i = 1 << (t & 7), a = B(e, r), o = e.bitOr(a, F(e, i)), s = e.bitAnd(a, F(e, 255 & ~i));
	X(e, r, e.select(D.number, n, () => o, () => s));
}, Tt = (e, t) => {
	let n = L(e, e.add(R(e, 129), F(e, 1)));
	z(e, 129, n), e.store8(M, n, L(e, t));
}, Et = (e, t) => {
	Tt(e, F(e, t & 255)), Tt(e, F(e, t >> 8 & 255));
}, Dt = (e, t) => {
	let n = L(e, t), r = L(e, e.shiftRightUnsigned(t, F(e, 8)));
	Tt(e, n), Tt(e, r);
}, Ot = (e) => {
	let t = R(e, 129), n = e.load8(M, t);
	return z(e, 129, L(e, e.subtract(t, F(e, 1)))), n;
}, kt = (e, t) => {
	e.writeState("pc", F(e, t & P));
}, At = (e, t) => {
	e.writeState("pc", e.bitAnd(t, F(e, P)));
}, Z = (e, t, n) => {
	e.if(t, (e) => {
		e.writeState("pc", e.constant(D.number, n & P));
	});
}, jt = (e, t) => e.select(D.number, ut(e, 142, 1), (e) => e.constant(D.number, 255), (e) => e.load8(rt, t)), Mt = (e, t, n) => {
	e.if(e.not(ut(e, 142, 1)), (e) => {
		e.store8(rt, t, L(e, n));
	});
}, Nt = (e, t, n, r) => {
	let i = r ? ft(e) : F(e, 0), a = e.add(e.add(t, n), i), o = L(e, a), s = e.add(e.add(e.bitAnd(t, F(e, 15)), e.bitAnd(n, F(e, 15))), i), c = e.notEqual(D.number, e.bitAnd(e.bitAnd(e.bitXor(t, o), e.bitXor(n, o)), F(e, 128)), F(e, 0));
	pt(e, e.greaterThan(a, F(e, 255)), e.greaterThan(s, F(e, 15)), c), U(e, o);
}, Pt = (e, t, n) => {
	let r = ft(e), i = e.add(n, r), a = L(e, e.subtract(t, i));
	pt(e, e.lessThan(t, i), e.lessThan(e.bitAnd(t, F(e, 15)), e.add(e.bitAnd(n, F(e, 15)), r)), e.notEqual(D.number, e.bitAnd(e.bitAnd(e.bitXor(t, n), e.bitXor(t, a)), F(e, 128)), F(e, 0))), U(e, a);
}, Ft = (e, t, n) => {
	let r = V(e);
	switch (t) {
		case 32: return Nt(e, r, n, !1);
		case 48: return Nt(e, r, n, !0);
		case 64: return U(e, e.bitOr(r, n));
		case 80: return U(e, e.bitAnd(r, n));
		case 96: return U(e, e.bitXor(r, n));
		case 144: return Pt(e, r, n);
		default: throw Error(`iap15f2k61s2: 未实现的 ALU 组 ${t.toString(16)}`);
	}
}, It = (e) => {
	let t = V(e), n = W(e), r = e.notEqual(D.number, e.bitAnd(H(e), F(e, 64)), F(e, 0)), i = e.greaterThan(e.bitAnd(t, F(e, 15)), F(e, 9)), a = e.or(r, () => i), o = F(e, 6), s = F(e, 0), c = e.select(D.number, a, () => o, () => s), l = e.add(t, c), u = e.lessThan(l, t), d = e.or(n, () => u), f = e.greaterThan(l, F(e, 153)), p = e.or(d, () => f), m = F(e, 96), ee = e.select(D.number, p, () => m, () => s), h = e.add(l, ee), g = e.lessThan(h, l);
	pt(e, e.or(d, () => g), I(e, !1), I(e, !1)), U(e, h);
}, Lt = (/* @__PURE__ */ new Uint8Array(256)).fill(1), Q = (e, t) => {
	for (let n of e) Lt[n] = t;
}, $ = (e, t) => Array.from({ length: t - e + 1 }, (t, n) => e + n);
Q([
	36,
	37,
	38,
	39
], 2), Q($(40, 47), 1), Q([
	52,
	53,
	54,
	55
], 2), Q($(56, 63), 1), Q([
	148,
	149,
	150,
	151
], 2), Q($(152, 159), 1), Q([4, 163], 1), Q([
	5,
	6,
	7
], 3), Q($(8, 15), 2), Q([20], 1), Q([
	21,
	22,
	23
], 3), Q($(24, 31), 2), Q([164], 2), Q([132], 6), Q([212], 3), Q([
	84,
	85,
	86,
	87
], 2), Q($(88, 95), 1), Q([82, 83], 3), Q([
	68,
	69,
	70,
	71
], 2), Q($(72, 79), 1), Q([66, 67], 3), Q([
	100,
	101,
	102,
	103
], 2), Q($(104, 111), 1), Q([
	228,
	244,
	35,
	51,
	3,
	19,
	196
], 1), Q([
	195,
	211,
	179
], 1), Q($(232, 239), 1), Q([229], 2), Q([230, 231], 2), Q([116], 2), Q($(248, 255), 1), Q($(168, 175), 3), Q($(120, 127), 2), Q([245], 2), Q($(136, 143), 2), Q([133], 3), Q([134, 135], 3), Q([117], 3), Q([246, 247], 2), Q([166, 167], 3), Q([118, 119], 2), Q([144], 3), Q([131, 147], 4), Q([
	224,
	226,
	227,
	240,
	242,
	243
], 3), Q([192], 3), Q([208], 2), Q($(200, 207), 2), Q([197], 3), Q([
	198,
	199,
	214,
	215
], 3), Q([
	130,
	176,
	114,
	160,
	162
], 2), Q([
	146,
	194,
	210,
	178
], 3), Q($(1, 1), 3), Q([
	33,
	65,
	97,
	129,
	161,
	193,
	225
], 3), Q([17], 3), Q([
	49,
	81,
	113,
	145,
	177,
	209,
	241
], 3), Q([2, 18], 4), Q([34, 50], 4), Q([128], 3), Q([115], 5), Q([64, 80], 3), Q([96, 112], 4), Q([
	32,
	48,
	16
], 5), Q([181], 5), Q([180], 4), Q($(184, 191), 4), Q([182, 183], 5), Q($(216, 223), 4), Q([213], 5), Q([0, 165], 1);
function Rt(e) {
	return Lt[e & 255] ?? 1;
}
var zt = 3, Bt = 15, Vt = 1, Ht = 2;
function Ut(e) {
	e.store8(N, F(e, 0), F(e, 1));
}
function Wt(e) {
	e.store8(N, F(e, zt), F(e, 2));
}
function Gt(e, t) {
	if (t === void 0) return e.constant(D.bool, !1);
	let n = t.register === "IP" ? 184 : 181, r = t.register === "IP" ? 183 : 182;
	return e.notEqual(D.number, e.bitOr(lt(e, r, t.bit), lt(e, n, t.bit)), F(e, 0));
}
var Kt = class {
	sources = [];
	register(...e) {
		for (let t of e) {
			if (this.sources.some((e) => e.id === t.id)) throw Error(`iap15f2k61s2: 中断源重复 ${t.id}`);
			this.sources.push(t);
		}
		return this;
	}
	dispatch(e, t) {
		let n = e.load8(N, F(e, 0));
		e.if(e.notEqual(D.number, n, F(e, 0)), (e) => {
			let n = tt(e), r = n.load8(N, F(n, zt));
			n.if(n.equal(D.number, r, F(n, 0)), (e) => {
				let n = tt(e);
				n.store8(N, F(n, 0), F(n, 0)), n.if(ut(n, 168, 7), (e) => {
					let n = e.load8(N, F(e, 1)), r = this.queue("high"), i = this.queue("low");
					this.scan(e, n, Ht, r, t, (e) => this.scan(e, n, Vt, i, t, () => {}));
				});
			});
		});
	}
	queue(e) {
		return this.sources.filter((t) => e === "high" ? t.priority !== void 0 : t.priority === void 0).sort((e, t) => e.query - t.query);
	}
	scan(e, t, n, r, i, a) {
		e.if(e.lessThan(t, F(e, n)), (e) => this.choice(e, r, 0, i, a), (e) => a(tt(e)));
	}
	choice(e, t, n, r, i) {
		let a = t[n];
		if (a === void 0) {
			i(e);
			return;
		}
		let o = Gt(e, a.priority);
		e.if(e.and(a.enabled(e), (e) => a.pending(tt(e))), (e) => this.take(e, a, o, r), (e) => this.choice(tt(e), t, n + 1, r, i));
	}
	take(e, t, n, r) {
		let i = e.load8(N, F(e, 1)), a = e.load8(N, F(e, 2)), o = e.bitAnd(a, F(e, Bt));
		t.acknowledge?.(e), e.store8(N, e.add(F(e, 4), o), i), e.store8(N, F(e, 2), e.bitAnd(e.add(a, F(e, 1)), F(e, Bt))), e.store8(N, F(e, 1), e.select(D.number, n, (e) => e.constant(D.number, Ht), (e) => e.constant(D.number, Vt))), typeof r == "number" ? Et(e, r) : Dt(e, r);
		let s = 2 * j().cyclePs;
		e.writeState(it, e.add(e.readState(it, D.number), F(e, s))), e.redirect(t.vector, s);
	}
};
function qt(e) {
	let t = e.load8(N, F(e, 2)), n = e.bitAnd(e.subtract(t, F(e, 1)), F(e, Bt));
	e.store8(N, F(e, 2), n), e.store8(N, F(e, 1), e.load8(N, e.add(F(e, 4), n)));
	let r = Ot(e), i = Ot(e);
	Wt(e), At(e, e.bitOr(e.shiftLeft(r, F(e, 8)), i)), Ut(e);
}
// ../../devices/iap15f2k61s2/src/kernel/decode.ts
var Jt = (e) => (t, n) => ({
	size: t,
	cycles: Rt(e),
	emit: n
}), Yt = (e) => ({
	size: 1,
	cycles: Rt(e),
	emit: () => {}
}), Xt = (e) => e < 128 ? e : e - 256, Zt = (e, t) => {
	let n = (t) => e[t & 65535] ?? 0, r = n(t), i = Jt(r), a = n(t + 1), o = n(t + 2), s = a << 8 | o, c = t + 2 + Xt(a) & P, l = (t + 2 & 63488 | (r & 224) << 3 | a) & P, u = r & 240, d = r & 15;
	switch (r & 31) {
		case 1: return i(2, (e) => kt(e, l));
		case 17: return i(2, (e) => {
			Et(e, t + 2 & P), kt(e, l);
		});
	}
	if (d >= 4 && (u === 32 || u === 48 || u === 64 || u === 80 || u === 96 || u === 144)) switch (d) {
		case 4: return i(2, (e) => Ft(e, u, F(e, a)));
		case 5: return i(2, (e) => Ft(e, u, Y(e, a)));
		case 6:
		case 7: return i(1, (e) => Ft(e, u, J(e, d & 1)));
		default: return i(1, (e) => Ft(e, u, K(e, d & 7)));
	}
	switch (r) {
		case 0:
		case 165: return Yt(r);
		case 2: return i(3, (e) => kt(e, s));
		case 18: return i(3, (e) => {
			Et(e, t + 3 & P), kt(e, s);
		});
		case 3: return i(1, (e) => {
			let t = V(e);
			U(e, e.bitOr(e.shiftRightUnsigned(t, F(e, 1)), e.shiftLeft(t, F(e, 7))));
		});
		case 4: return i(1, (e) => U(e, e.add(V(e), F(e, 1))));
		case 5: return i(2, (e) => X(e, a, e.add(B(e, a), F(e, 1))));
		case 6:
		case 7: return i(1, (e) => {
			let t = r & 1;
			vt(e, t, e.add(J(e, t), F(e, 1)));
		});
		case 8:
		case 9:
		case 10:
		case 11:
		case 12:
		case 13:
		case 14:
		case 15: return i(1, (e) => {
			let t = r & 7;
			q(e, t, e.add(K(e, t), F(e, 1)));
		});
		case 16: return i(3, (e) => {
			let n = Ct(e, a);
			e.if(n, (e) => {
				wt(e, a, I(e, !1));
			}), Z(e, n, t + 3 + Xt(o) & P);
		});
		case 19: return i(1, (e) => {
			let t = V(e), n = ft(e);
			U(e, e.bitOr(e.shiftRightUnsigned(t, F(e, 1)), e.shiftLeft(n, F(e, 7)))), G(e, e.equal(D.number, e.bitAnd(t, F(e, 1)), F(e, 1)));
		});
		case 20: return i(1, (e) => U(e, e.subtract(V(e), F(e, 1))));
		case 21: return i(2, (e) => X(e, a, e.subtract(B(e, a), F(e, 1))));
		case 22:
		case 23: return i(1, (e) => {
			let t = r & 1;
			vt(e, t, e.subtract(J(e, t), F(e, 1)));
		});
		case 24:
		case 25:
		case 26:
		case 27:
		case 28:
		case 29:
		case 30:
		case 31: return i(1, (e) => {
			let t = r & 7;
			q(e, t, e.subtract(K(e, t), F(e, 1)));
		});
		case 32: return i(3, (e) => Z(e, St(e, a), t + 3 + Xt(o) & P));
		case 34: return i(1, (e) => {
			let t = Ot(e), n = Ot(e);
			At(e, e.bitOr(e.shiftLeft(t, F(e, 8)), n));
		});
		case 50: return i(1, (e) => qt(e));
		case 35: return i(1, (e) => {
			let t = V(e);
			U(e, e.bitOr(e.shiftLeft(t, F(e, 1)), e.shiftRightUnsigned(t, F(e, 7))));
		});
		case 48: return i(3, (e) => Z(e, e.not(St(e, a)), t + 3 + Xt(o) & P));
		case 51: return i(1, (e) => {
			let t = V(e), n = ft(e);
			U(e, e.bitOr(e.shiftLeft(t, F(e, 1)), n)), G(e, e.equal(D.number, e.bitAnd(t, F(e, 128)), F(e, 128)));
		});
		case 64: return i(2, (e) => Z(e, W(e), c));
		case 66: return i(2, (e) => X(e, a, e.bitOr(B(e, a), V(e))));
		case 67: return i(3, (e) => X(e, a, e.bitOr(B(e, a), F(e, o))));
		case 80: return i(2, (e) => Z(e, e.not(W(e)), c));
		case 82: return i(2, (e) => X(e, a, e.bitAnd(B(e, a), V(e))));
		case 83: return i(3, (e) => X(e, a, e.bitAnd(B(e, a), F(e, o))));
		case 96: return i(2, (e) => Z(e, e.equal(D.number, V(e), F(e, 0)), c));
		case 98: return i(2, (e) => X(e, a, e.bitXor(B(e, a), V(e))));
		case 99: return i(3, (e) => X(e, a, e.bitXor(B(e, a), F(e, o))));
		case 112: return i(2, (e) => Z(e, e.notEqual(D.number, V(e), F(e, 0)), c));
		case 114: return i(2, (e) => {
			let t = St(e, a);
			G(e, e.or(W(e), () => t));
		});
		case 115: return i(1, (e) => At(e, e.add(V(e), mt(e))));
		case 116: return i(2, (e) => U(e, F(e, a)));
		case 117: return i(3, (e) => X(e, a, F(e, o)));
		case 118:
		case 119: return i(2, (e) => vt(e, r & 1, F(e, a)));
		case 120:
		case 121:
		case 122:
		case 123:
		case 124:
		case 125:
		case 126:
		case 127: return i(2, (e) => q(e, r & 7, F(e, a)));
		case 128: return i(2, (e) => kt(e, c));
		case 130: return i(2, (e) => {
			let t = St(e, a);
			G(e, e.and(W(e), () => t));
		});
		case 131: return i(1, (e) => {
			let n = e.bitAnd(e.add(V(e), F(e, t + 1 & P)), F(e, P));
			U(e, e.load8(nt, n));
		});
		case 132: return i(1, (e) => {
			let t = V(e), n = R(e, 240), r = e.equal(D.number, n, F(e, 0)), i = e.floor(e.divide(t, n)), a = e.remainder(t, n);
			U(e, e.select(D.number, r, () => t, () => i)), z(e, 240, e.select(D.number, r, () => n, () => a)), pt(e, I(e, !1), I(e, !1), r);
		});
		case 133: return i(3, (e) => X(e, o, Y(e, a)));
		case 134:
		case 135: return i(2, (e) => X(e, a, J(e, r & 1)));
		case 136:
		case 137:
		case 138:
		case 139:
		case 140:
		case 141:
		case 142:
		case 143: return i(2, (e) => X(e, a, K(e, r & 7)));
		case 144: return i(3, (e) => ht(e, F(e, s)));
		case 146: return i(2, (e) => wt(e, a, W(e)));
		case 147: return i(1, (e) => {
			let t = e.bitAnd(e.add(V(e), mt(e)), F(e, P));
			U(e, e.load8(nt, t));
		});
		case 160: return i(2, (e) => {
			let t = e.not(St(e, a));
			G(e, e.or(W(e), () => t));
		});
		case 162: return i(2, (e) => G(e, St(e, a)));
		case 163: return i(1, (e) => ht(e, e.add(mt(e), F(e, 1))));
		case 164: return i(1, (e) => {
			let t = e.multiply(V(e), R(e, 240)), n = e.bitAnd(e.shiftRightUnsigned(t, F(e, 8)), F(e, 255));
			U(e, e.bitAnd(t, F(e, 255))), z(e, 240, n), pt(e, I(e, !1), I(e, !1), e.notEqual(D.number, n, F(e, 0)));
		});
		case 166:
		case 167: return i(2, (e) => vt(e, r & 1, Y(e, a)));
		case 168:
		case 169:
		case 170:
		case 171:
		case 172:
		case 173:
		case 174:
		case 175: return i(2, (e) => q(e, r & 7, Y(e, a)));
		case 176: return i(2, (e) => {
			let t = e.not(St(e, a));
			G(e, e.and(W(e), () => t));
		});
		case 178: return i(2, (e) => wt(e, a, e.not(Ct(e, a))));
		case 179: return i(1, (e) => G(e, e.not(W(e))));
		case 180:
		case 181:
		case 182:
		case 183:
		case 184:
		case 185:
		case 186:
		case 187:
		case 188:
		case 189:
		case 190:
		case 191: return i(3, (e) => {
			let n = r === 180 || r === 181 ? V(e) : r <= 183 ? J(e, r & 1) : K(e, r & 7), i = r === 180 || r >= 182 ? F(e, a) : Y(e, a), s = t + 3 + Xt(o) & P;
			G(e, e.lessThan(n, i)), Z(e, e.notEqual(D.number, n, i), s);
		});
		case 192: return i(2, (e) => Tt(e, Y(e, a)));
		case 194: return i(2, (e) => wt(e, a, I(e, !1)));
		case 195: return i(1, (e) => G(e, I(e, !1)));
		case 196: return i(1, (e) => {
			let t = V(e);
			U(e, e.bitOr(e.shiftLeft(t, F(e, 4)), e.shiftRightUnsigned(t, F(e, 4))));
		});
		case 197: return i(2, (e) => {
			let t = Y(e, a), n = V(e);
			U(e, t), X(e, a, n);
		});
		case 198:
		case 199: return i(1, (e) => {
			let t = r & 1, n = J(e, t), i = V(e);
			U(e, n), vt(e, t, i);
		});
		case 200:
		case 201:
		case 202:
		case 203:
		case 204:
		case 205:
		case 206:
		case 207: return i(1, (e) => {
			let t = r & 7, n = K(e, t), i = V(e);
			U(e, n), q(e, t, i);
		});
		case 208: return i(2, (e) => X(e, a, Ot(e)));
		case 210: return i(2, (e) => wt(e, a, I(e, !0)));
		case 211: return i(1, (e) => G(e, I(e, !0)));
		case 212: return i(1, (e) => It(e));
		case 213: return i(3, (e) => {
			let n = L(e, e.subtract(B(e, a), F(e, 1)));
			Z(e, e.notEqual(D.number, n, F(e, 0)), t + 3 + Xt(o) & P), X(e, a, n);
		});
		case 214:
		case 215: return i(1, (e) => {
			let t = r & 1, n = J(e, t), i = V(e);
			U(e, e.bitOr(e.bitAnd(i, F(e, 240)), e.bitAnd(n, F(e, 15)))), vt(e, t, e.bitOr(e.bitAnd(n, F(e, 240)), e.bitAnd(i, F(e, 15))));
		});
		case 216:
		case 217:
		case 218:
		case 219:
		case 220:
		case 221:
		case 222:
		case 223: return i(2, (e) => {
			let t = r & 7, n = L(e, e.subtract(K(e, t), F(e, 1)));
			Z(e, e.notEqual(D.number, n, F(e, 0)), c), q(e, t, n);
		});
		case 224: return i(1, (e) => {
			U(e, jt(e, e.bitAnd(mt(e), F(e, at))));
		});
		case 226:
		case 227: return i(1, (e) => {
			U(e, jt(e, e.bitAnd(_t(e, r & 1), F(e, 255))));
		});
		case 228: return i(1, (e) => U(e, F(e, 0)));
		case 229: return i(2, (e) => U(e, Y(e, a)));
		case 230:
		case 231: return i(1, (e) => U(e, J(e, r & 1)));
		case 232:
		case 233:
		case 234:
		case 235:
		case 236:
		case 237:
		case 238:
		case 239: return i(1, (e) => U(e, K(e, r & 7)));
		case 240: return i(1, (e) => {
			Mt(e, e.bitAnd(mt(e), F(e, at)), V(e));
		});
		case 242:
		case 243: return i(1, (e) => {
			Mt(e, e.bitAnd(_t(e, r & 1), F(e, 255)), V(e));
		});
		case 244: return i(1, (e) => U(e, e.bitXor(V(e), F(e, 255))));
		case 245: return i(2, (e) => X(e, a, V(e)));
		case 246:
		case 247: return i(1, (e) => vt(e, r & 1, V(e)));
		case 248:
		case 249:
		case 250:
		case 251:
		case 252:
		case 253:
		case 254:
		case 255: return i(1, (e) => q(e, r & 7, V(e)));
		default: return Yt(r);
	}
}, Qt = class {
	readers = /* @__PURE__ */ new Map();
	writers = /* @__PURE__ */ new Map();
	synchronize;
	suppress = 0;
	internal = 0;
	get withinHook() {
		return this.internal > 0;
	}
	hooked(e) {
		this.internal += 1;
		try {
			return e();
		} finally {
			--this.internal;
		}
	}
	muted(e) {
		this.suppress += 1;
		try {
			return e();
		} finally {
			--this.suppress;
		}
	}
	onRead(e, t) {
		if (this.readers.has(e)) throw Error(`iap15f2k61s2: SFR 读钩子重复 ${e.toString(16)}`);
		this.readers.set(e, t);
	}
	onWrite(e, t) {
		let n = this.writers.get(e);
		n === void 0 ? this.writers.set(e, [t]) : n.push(t);
	}
	read(e, t) {
		this.suppress || this.synchronize?.(e, t);
		let n = this.readers.get(t);
		return n === void 0 ? e.load8("sfr", e.constant(D.number, t & 127)) : this.hooked(() => n(e, t));
	}
	write(e, t, n) {
		let r = e.bitAnd(n, e.constant(D.number, 255));
		e.store8("sfr", e.constant(D.number, t & 127), r);
		let i = this.writers.get(t);
		if (i !== void 0) {
			this.suppress += 1;
			try {
				this.hooked(() => {
					for (let n of i) n(e, t, r);
				});
			} finally {
				--this.suppress;
			}
		}
	}
}, $t = [
	{
		index: 0,
		latch: 128,
		mode0: 148,
		mode1: 147
	},
	{
		index: 1,
		latch: 144,
		mode0: 146,
		mode1: 145
	},
	{
		index: 2,
		latch: 160,
		mode0: 150,
		mode1: 149
	},
	{
		index: 3,
		latch: 176,
		mode0: 178,
		mode1: 177
	},
	{
		index: 4,
		latch: 192,
		mode0: 180,
		mode1: 179
	}
];
new Map($t.flatMap((e) => [
	[e.latch, e],
	[e.mode0, e],
	[e.mode1, e]
]));
var en = (e, t) => `P${e}_${t}`;
function tn(e, t, n) {
	let r = e.field(e.readSample(en(t, n)), "level"), i = e.equal(D.logic, r, e.constant(D.logic, D.logic.members.high)), a = e.constant(D.number, 1), o = e.constant(D.number, 0);
	return e.shiftLeft(e.select(D.number, i, () => a, () => o), F(e, n));
}
function nn(e, t) {
	let n = tn(e, t, 0);
	for (let r = 1; r < 8; r += 1) n = e.bitOr(n, tn(e, t, r));
	return n;
}
function rn(e, t, n) {
	let r = e.field(e.readSample(en(t, n)), "level"), i = e.equal(D.logic, r, e.constant(D.logic, D.logic.members.high));
	return e.select(D.number, i, (e) => e.constant(D.number, 1), (e) => e.constant(D.number, 0));
}
$t.flatMap((e) => [
	e.latch,
	e.mode0,
	e.mode1
]);
// at89c52/src/model.ts
var an = /* @__PURE__ */ new Set([
	2,
	16,
	18,
	32,
	34,
	48,
	50,
	64,
	67,
	80,
	83,
	96,
	99,
	112,
	114,
	115,
	117,
	128,
	130,
	131,
	133,
	134,
	135,
	144,
	146,
	147,
	160,
	163,
	166,
	167,
	176,
	192,
	208,
	213
]), on = /* @__PURE__ */ new Set([
	224,
	226,
	227,
	240,
	242,
	243
]);
function sn(e) {
	return e === 132 || e === 164 ? 4 : (e & 31) == 1 || (e & 31) == 17 || an.has(e) || e >= 136 && e <= 143 || e >= 168 && e <= 175 || e >= 180 && e <= 191 || e >= 216 && e <= 223 ? 2 : 1;
}
var cn = (e) => {
	let t = Math.round(0xae9f7bcc000 / e.props.clockFrequency), n = new Qt();
	for (let e = 0; e < 4; e++) n.onWrite(128 + e * 16, (t, n, r) => {
		let i = t.resistor("GND", t.constant(D.number, 25)), a = e === 0 ? t.combineIntents() : t.resistor("VCC", t.constant(D.number, 1e4));
		for (let n = 0; n < 8; n++) {
			let o = t.notEqual(D.number, t.bitAnd(r, t.constant(D.number, 1 << n)), t.constant(D.number, 0));
			t.writeIntent(`P${e}_${n}`, t.select(D.intent, o, () => a, () => i));
		}
	});
	let r = /* @__PURE__ */ new Set([
		128,
		129,
		130,
		131,
		144,
		160,
		176,
		208,
		224,
		240
	]);
	for (let e = 128; e <= 255; e++) {
		if (r.has(e)) continue;
		let t = () => {
			throw Error(`AT89C52 GPIO example: SFR 0x${e.toString(16)} is not modeled.`);
		};
		n.onRead(e, t), n.onWrite(e, t);
	}
	let i, a = {
		clockFrequency: e.props.clockFrequency,
		cyclePs: t,
		pcState: "pc",
		sfr: n,
		irq: new Kt(),
		peripherals: [],
		ports: {
			readPin: rn,
			readPort: nn
		},
		timedReads: /* @__PURE__ */ new Set(),
		timedWrites: /* @__PURE__ */ new Set(),
		beginAccessProbe() {
			i = {
				reads: /* @__PURE__ */ new Set(),
				writes: /* @__PURE__ */ new Set()
			};
		},
		endAccessProbe() {
			let e = i ?? {
				reads: /* @__PURE__ */ new Set(),
				writes: /* @__PURE__ */ new Set()
			};
			return i = void 0, e;
		},
		noteSfrRead(e) {
			n.withinHook || i?.reads.add(e & 255);
		},
		noteSfrWrite(e) {
			n.withinHook || i?.writes.add(e & 255);
		}
	};
	e.attachJit({
		entry: "cpu",
		code: "code",
		pc: "pc",
		translate({ code: e, pc: n }) {
			if (n >= 8192) throw Error(`AT89C52 program counter exceeds internal Flash: ${n}`);
			let r = e[n] ?? 255;
			if (on.has(r) || r === 50 || r === 165) throw Error(`AT89C52 GPIO example: opcode 0x${r.toString(16)} is not supported.`);
			return et(a, () => {
				let i = Zt(e, n), a = Qe();
				return a.instruction({
					pc: n,
					nextPc: n + i.size & 65535
				}, (e) => {
					i.emit(e), e.elapse(sn(r) * t);
				}), a.finish();
			});
		}
	}), e.loadBytes("code", (/* @__PURE__ */ new Uint8Array(8192)).fill(255));
	for (let t of e.props.program.segments) e.loadBytes("code", t.data.slice(), t.address);
	return {
		methods: {},
		sync() {},
		dispose() {}
	};
}, ln = {
	kind: "device",
	name: "At89c52",
	declarations: [
		{
			kind: "property",
			name: "clockFrequency",
			type: { kind: "number" },
			default: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 12e6
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "memory",
			name: "code",
			public: !1,
			length: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 8192
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "memory",
			name: "iram",
			public: !1,
			length: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 256
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "memory",
			name: "sfr",
			public: !1,
			length: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 128
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "memory",
			name: "periph",
			public: !1,
			length: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 256
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "state",
			name: "pc",
			type: { kind: "number" },
			initial: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 0
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "start",
			body: { operations: [
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1
					},
					result: 0,
					type: { kind: "number" }
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 7
					},
					result: 1,
					type: { kind: "number" }
				},
				{
					kind: "store8",
					memory: {
						kind: "memory",
						name: "sfr"
					},
					offset: 0,
					value: 1
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 0
					},
					result: 2,
					type: { kind: "number" }
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 255
					},
					result: 3,
					type: { kind: "number" }
				},
				{
					kind: "store8",
					memory: {
						kind: "memory",
						name: "sfr"
					},
					offset: 2,
					value: 3
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 16
					},
					result: 4,
					type: { kind: "number" }
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 255
					},
					result: 5,
					type: { kind: "number" }
				},
				{
					kind: "store8",
					memory: {
						kind: "memory",
						name: "sfr"
					},
					offset: 4,
					value: 5
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 32
					},
					result: 6,
					type: { kind: "number" }
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 255
					},
					result: 7,
					type: { kind: "number" }
				},
				{
					kind: "store8",
					memory: {
						kind: "memory",
						name: "sfr"
					},
					offset: 6,
					value: 7
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 48
					},
					result: 8,
					type: { kind: "number" }
				},
				{
					kind: "constant",
					constant: {
						kind: "number",
						value: 255
					},
					result: 9,
					type: { kind: "number" }
				},
				{
					kind: "store8",
					memory: {
						kind: "memory",
						name: "sfr"
					},
					offset: 8,
					value: 9
				}
			] }
		},
		{
			kind: "pin",
			name: "VCC"
		},
		{
			kind: "pin",
			name: "GND"
		},
		{
			kind: "pin",
			name: "P0_0",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P0_1",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P0_2",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P0_3",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P0_4",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P0_5",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P0_6",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P0_7",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			}
		},
		{
			kind: "pin",
			name: "P1_0",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P1_1",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P1_2",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P1_3",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P1_4",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P1_5",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P1_6",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P1_7",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_0",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_1",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_2",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_3",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_4",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_5",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_6",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P2_7",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_0",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_1",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_2",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_3",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_4",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_5",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_6",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "P3_7",
			low: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 1.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			high: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 3.5
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e4
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "VCC"
						},
						resistance: 0,
						result: 1,
						type: { kind: "intent" }
					},
					{
						kind: "combineIntents",
						values: [1],
						result: 2,
						type: { kind: "intent" }
					},
					{
						kind: "returnValue",
						value: 2
					}
				] }
			}
		},
		{
			kind: "pin",
			name: "RST"
		},
		{
			kind: "pin",
			name: "XTAL1"
		},
		{
			kind: "pin",
			name: "XTAL2"
		},
		{
			kind: "pin",
			name: "PSEN"
		},
		{
			kind: "pin",
			name: "ALE"
		},
		{
			kind: "pin",
			name: "EA"
		}
	]
};
export { cn as create, ln as model };
