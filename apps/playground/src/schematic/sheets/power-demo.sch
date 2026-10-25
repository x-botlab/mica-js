{
  "version": 1,
  "sheet": {
    "symbols": [
      {
        "id": "c4d5e6f7-2b3a-4c1d-9e8f-0a1b2c3d4e58",
        "device": "mica:teaching-mcu",
        "designator": "U1",
        "x": 60,
        "y": 100,
        "rotation": 0
      },
      {
        "id": "d0a1b2c3-4d5e-4f60-8a9b-0c1d2e3f4a07",
        "device": "lab:power-load",
        "designator": "U3",
        "x": 360,
        "y": 100,
        "rotation": 0
      },
      {
        "id": "e0000031-2222-4333-8444-000000000031",
        "device": "builtin:text",
        "x": 60,
        "y": 20,
        "rotation": 0,
        "properties": {
          "text": "电源域（RFC 0007）：U3 声明 powerDomains: [{ name: 'vdd', voltage: 3.3 }]"
        }
      },
      {
        "id": "e0000032-2222-4333-8444-000000000032",
        "device": "builtin:text",
        "x": 60,
        "y": 300,
        "rotation": 0,
        "properties": {
          "text": "turnOff('U3','vdd')：驱动释放、采样读 0、阶段跳过，配置与输出锁存保留；turnOn 恢复。"
        }
      },
      {
        "id": "e0000033-2222-4333-8444-000000000033",
        "device": "builtin:text",
        "x": 60,
        "y": 360,
        "rotation": 0,
        "properties": {
          "text": "画布上的电源开关 widget 绑定到 U3.enable，用同一个器件演示门控；域级开关由 devices.test.ts 覆盖。"
        }
      }
    ],
    "wires": [],
    "junctions": []
  }
}
