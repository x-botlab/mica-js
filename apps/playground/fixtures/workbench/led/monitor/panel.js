// led/src/monitor/panel.js
var e = await acquireDeviceViewApi(), t = document.querySelector("#brightness"), n = (e) => {
	t.textContent = Number(e).toFixed(3);
}, r = e.model?.events.onDidBrightnessChange((e) => n(e.value));
n(await e.model?.methods.getBrightness(null) ?? 0), e.onDidClose(() => r?.dispose());
