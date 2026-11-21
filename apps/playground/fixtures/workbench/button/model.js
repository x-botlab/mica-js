// button/src/model.ts
var e = (e) => {
	let t = !1;
	return e.events.onDidPressedChange.fire(t), {
		methods: {
			press(n) {
				return t = n, e.inputs.pressed.send(n), e.events.onDidPressedChange.fire(n), null;
			},
			getPressed: () => t
		},
		sync() {},
		dispose() {}
	};
}, t = {
	kind: "device",
	name: "Button",
	declarations: [
		{
			kind: "pin",
			name: "a1"
		},
		{
			kind: "pin",
			name: "a2",
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: .001
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "a1"
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
			name: "b1"
		},
		{
			kind: "pin",
			name: "b2",
			initial: {
				type: { kind: "intent" },
				body: { operations: [
					{
						kind: "constant",
						constant: {
							kind: "number",
							value: .001
						},
						result: 0,
						type: { kind: "number" }
					},
					{
						kind: "resistor",
						to: {
							kind: "pin",
							name: "b1"
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
			kind: "channel",
			name: "pressed",
			direction: "input",
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
			kind: "start",
			body: { operations: [{
				kind: "loop",
				body: { operations: [
					{
						kind: "receive",
						channel: "pressed",
						result: 0,
						type: { kind: "bool" }
					},
					{
						kind: "local",
						local: 0,
						type: { kind: "bool" },
						initial: 0
					},
					{
						kind: "localRead",
						local: 0,
						result: 1,
						type: { kind: "bool" }
					},
					{
						kind: "if",
						condition: 1,
						yes: { operations: [
							{
								kind: "constant",
								constant: {
									kind: "number",
									value: 1
								},
								result: 2,
								type: { kind: "number" }
							},
							{
								kind: "resistor",
								to: {
									kind: "pin",
									name: "b1"
								},
								resistance: 2,
								result: 3,
								type: { kind: "intent" }
							},
							{
								kind: "combineIntents",
								values: [3],
								result: 4,
								type: { kind: "intent" }
							},
							{
								kind: "writeIntent",
								pin: {
									kind: "pin",
									name: "a1"
								},
								value: 4
							}
						] },
						no: { operations: [{
							kind: "combineIntents",
							values: [],
							result: 5,
							type: { kind: "intent" }
						}, {
							kind: "writeIntent",
							pin: {
								kind: "pin",
								name: "a1"
							},
							value: 5
						}] }
					}
				] }
			}] }
		}
	]
};
export { e as create, t as model };
