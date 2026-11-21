// buzzer/src/model.ts
var e = (e) => {
	let t = !1;
	return {
		methods: { getActive: () => t },
		sync(n) {
			for (let r of n.outputs.active ?? []) t !== r.value && (t = r.value, e.events.onDidActiveChange.fire(t));
		},
		dispose() {}
	};
}, t = {
	kind: "device",
	name: "ActiveBuzzer",
	declarations: [
		{
			kind: "pin",
			name: "positive",
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
							name: "negative"
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
			name: "negative"
		},
		{
			kind: "channel",
			name: "active",
			direction: "output",
			type: { kind: "bool" },
			capacity: {
				type: { kind: "number" },
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "number",
						value: 8
					},
					result: 0,
					type: { kind: "number" }
				}, {
					kind: "returnValue",
					value: 0
				}] }
			},
			overflow: {
				type: {
					kind: "enum",
					name: "Overflow"
				},
				body: { operations: [{
					kind: "constant",
					constant: {
						kind: "enum",
						name: "Overflow",
						member: "drop_oldest"
					},
					result: 0,
					type: {
						kind: "enum",
						name: "Overflow"
					}
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
						name: "positive"
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
						name: "negative"
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
							kind: "localRead",
							local: 0,
							result: 11,
							type: {
								kind: "optional",
								inner: { kind: "number" }
							}
						},
						{
							kind: "nonNull",
							value: 11,
							result: 12,
							type: { kind: "number" }
						},
						{
							kind: "localRead",
							local: 1,
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
							kind: "binary",
							operator: "subtract",
							left: 12,
							right: 14,
							result: 15,
							type: { kind: "number" }
						},
						{
							kind: "constant",
							constant: {
								kind: "number",
								value: 2.5
							},
							result: 16,
							type: { kind: "number" }
						},
						{
							kind: "binary",
							operator: "greaterThanOrEqual",
							left: 15,
							right: 16,
							result: 17,
							type: { kind: "bool" }
						},
						{
							kind: "send",
							channel: "active",
							value: 17
						}
					] },
					no: { operations: [{
						kind: "constant",
						constant: {
							kind: "bool",
							value: !1
						},
						result: 18,
						type: { kind: "bool" }
					}, {
						kind: "send",
						channel: "active",
						value: 18
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
			name: "positiveChanged",
			sourcePath: [
				"positive",
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
			name: "negativeChanged",
			sourcePath: [
				"negative",
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
