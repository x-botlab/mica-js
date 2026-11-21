// buzzer/src/view.ts
function e(e) {
	let t = !1, n = e.audio.tone({
		frequency: 2e3,
		type: "square",
		volume: 0
	});
	function r(r) {
		t = r, n.set({ volume: t ? .06 : 0 }, { rampMs: 5 }), e.invalidate();
	}
	let i = e.model?.events.onDidActiveChange((e) => r(e.value));
	return {
		async initialize() {
			r(await e.model?.methods.getActive(null) ?? !1);
		},
		renderOverlay(e) {
			t && (e.strokeStyle = "#f6cc68", e.lineWidth = .4, e.beginPath(), e.arc(5, 4, 2.4, -.8, .8), e.stroke());
		},
		dispose() {
			i?.dispose(), n.stop();
		}
	};
}
export { e as default };
