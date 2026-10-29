# @mica-js/device

器件描述、同步 JS 工厂加载与实例生命周期。文件定位、读取及 JSON 解析由宿主 `IDeviceProvider` 负责，本包不扫描文件系统。

从 `@mica-js/device` 导入 `parseDeviceDescription`、`loadDeviceModule`、`resolveDeviceProperties` 和 `createDeviceInstance`；实例使用独立的只读属性快照。
