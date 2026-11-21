// led/src/model.ts
var e = (e) => {
	let t = 0;
	return e.events.onDidBrightnessChange.fire(t), {
		methods: { getBrightness: () => t },
		sync(n) {
			for (let r of n.outputs.brightness ?? []) t = r.value, e.events.onDidBrightnessChange.fire(t);
		},
		dispose() {}
	};
}, t = {
	kind: "device",
	name: "Led",
	declarations: [
		{
			kind: "pin",
			name: "anode",
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: 1e3
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "cathode"
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
			name: "cathode"
		},
		{
			kind: "channel",
			name: "brightness",
			direction: "output",
			type: { kind: "number" },
			capacity: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 64
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
			kind: "function",
			name: "report",
			pure: !1,
			params: [],
			body: { operations: [
				{
					kind: "readSample",
					pin: {
						kind: "pin",
						name: "anode"
					},
					result: 0,
					type: { kind: "sample" }
				},
				{
					kind: "field",
					value: 0,
					field: "voltage",
					result: 1,
					type: {
						kind: "optional",
						inner: { kind: "number" }
					}
				},
				{
					kind: "local",
					local: 0,
					type: {
						kind: "optional",
						inner: { kind: "number" }
					},
					initial: 1
				},
				{
					kind: "readSample",
					pin: {
						kind: "pin",
						name: "cathode"
					},
					result: 2,
					type: { kind: "sample" }
				},
				{
					kind: "field",
					value: 2,
					field: "voltage",
					result: 3,
					type: {
						kind: "optional",
						inner: { kind: "number" }
					}
				},
				{
					kind: "local",
					local: 1,
					type: {
						kind: "optional",
						inner: { kind: "number" }
					},
					initial: 3
				},
				{
					kind: "localRead",
					local: 0,
					result: 4,
					type: {
						kind: "optional",
						inner: { kind: "number" }
					}
				},
				{
					kind: "isNone",
					value: 4,
					result: 5,
					type: { kind: "bool" }
				},
				{
					kind: "unary",
					operator: "not",
					value: 5,
					result: 6,
					type: { kind: "bool" }
				},
				{
					kind: "and",
					left: 6,
					right: {
						type: { kind: "bool" },
						body: { operations: [
							{
								kind: "localRead",
								local: 1,
								result: 7,
								type: {
									kind: "optional",
									inner: { kind: "number" }
								}
							},
							{
								kind: "isNone",
								value: 7,
								result: 8,
								type: { kind: "bool" }
							},
							{
								kind: "unary",
								operator: "not",
								value: 8,
								result: 9,
								type: { kind: "bool" }
							},
							{
								kind: "yield",
								value: 9
							}
						] }
					},
					result: 10,
					type: { kind: "bool" }
				},
				{
					kind: "if",
					condition: 10,
					yes: { operations: [
						{
							kind: "constant",
							constant: {
								kind: "number",
								value: 0
							},
							result: 11,
							type: { kind: "number" }
						},
						{
							kind: "constant",
							constant: {
								kind: "number",
								value: 1
							},
							result: 12,
							type: { kind: "number" }
						},
						{
							kind: "localRead",
							local: 0,
							result: 13,
							type: {
								kind: "optional",
								inner: { kind: "number" }
							}
						},
						{
							kind: "nonNull",
							value: 13,
							result: 14,
							type: { kind: "number" }
						},
						{
							kind: "localRead",
							local: 1,
							result: 15,
							type: {
								kind: "optional",
								inner: { kind: "number" }
							}
						},
						{
							kind: "nonNull",
							value: 15,
							result: 16,
							type: { kind: "number" }
						},
						{
							kind: "binary",
							operator: "subtract",
							left: 14,
							right: 16,
							result: 17,
							type: { kind: "number" }
						},
						{
							kind: "constant",
							constant: {
								kind: "number",
								value: 5
							},
							result: 18,
							type: { kind: "number" }
						},
						{
							kind: "binary",
							operator: "divide",
							left: 17,
							right: 18,
							result: 19,
							type: { kind: "number" }
						},
						{
							kind: "numeric",
							builtin: "min",
							args: [12, 19],
							result: 20,
							type: { kind: "number" }
						},
						{
							kind: "numeric",
							builtin: "max",
							args: [11, 20],
							result: 21,
							type: { kind: "number" }
						},
						{
							kind: "send",
							channel: "brightness",
							value: 21
						}
					] },
					no: { operations: [{
						kind: "constant",
						constant: {
							kind: "number",
							value: 0
						},
						result: 22,
						type: { kind: "number" }
					}, {
						kind: "send",
						channel: "brightness",
						value: 22
					}] }
				}
			] }
		},
		{
			kind: "start",
			body: { operations: [{
				kind: "call",
				name: "report",
				pure: !1,
				args: []
			}] }
		},
		{
			kind: "reaction",
			name: "anodeChanged",
			sourcePath: [
				"anode",
				"sample",
				"voltage"
			],
			sourceType: {
				kind: "optional",
				inner: { kind: "number" }
			},
			previous: "previous",
			current: "next",
			captures: [],
			body: { operations: [{
				kind: "call",
				name: "report",
				pure: !1,
				args: []
			}] }
		},
		{
			kind: "reaction",
			name: "cathodeChanged",
			sourcePath: [
				"cathode",
				"sample",
				"voltage"
			],
			sourceType: {
				kind: "optional",
				inner: { kind: "number" }
			},
			previous: "previous",
			current: "next",
			captures: [],
			body: { operations: [{
				kind: "call",
				name: "report",
				pure: !1,
				args: []
			}] }
		}
	]
};
export { e as create, t as model };
