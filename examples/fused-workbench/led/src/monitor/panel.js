const api = await acquireDeviceViewApi();
const brightness = document.querySelector('#brightness');
const render = (value) => {
  brightness.textContent = Number(value).toFixed(3);
};
const subscription = api.model?.events.onDidBrightnessChange((event) => render(event.value));
render((await api.model?.methods.getBrightness(null)) ?? 0);
api.onDidClose(() => subscription?.dispose());
