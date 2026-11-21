// button/src/view.ts
function e(e) {
	let t = !1, n = e.model?.events.onDidPressedChange((n) => {
		t = n.value, e.invalidate();
	});
	return {
		async initialize() {
			t = await e.model?.methods.getPressed(null) ?? !1, e.invalidate();
		},
		renderOverlay(n) {
			n.fillStyle = t ? "#e2a138" : "#f6cc68", n.beginPath(), n.roundRect(1.6, 1.6, 6.8, 6.8, 1.2), n.fill(), n.fillStyle = "#292823", n.textAlign = "center", n.textBaseline = "middle", n.font = "1.2px sans-serif", n.fillText(e.props.label ?? "PRESS", 5, 5, 6);
		},
		async input(t) {
			t.type === "pointerdown" ? await e.model?.methods.press(!0) : t.type === "pointerup" && await e.model?.methods.press(!1);
		},
		dispose() {
			n?.dispose();
		}
	};
}
export { e as default };
