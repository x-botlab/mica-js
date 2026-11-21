// led/src/view.ts
function e(e) {
	let t = 0, n = e.model?.events.onDidBrightnessChange((n) => {
		t = n.value, e.invalidate();
	});
	return {
		async initialize() {
			t = await e.model?.methods.getBrightness(null) ?? 0, e.invalidate();
		},
		renderOverlay(e) {
			e.fillStyle = t > .5 ? "#ff4857" : "#74252e", e.beginPath(), e.arc(5, 4, 2.6, 0, Math.PI * 2), e.fill(), t > .5 && (e.fillStyle = "#ffc2c9", e.beginPath(), e.arc(4.2, 3.2, .7, 0, Math.PI * 2), e.fill());
		},
		dispose() {
			n?.dispose();
		}
	};
}
export { e as default };
