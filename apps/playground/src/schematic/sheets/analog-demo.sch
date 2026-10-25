{
  "version": 1,
  "sheet": {
    "symbols": [
      {
        "id": "c4d5e6f7-2b3a-4c1d-9e8f-0a1b2c3d4e58",
        "device": "mica:teaching-mcu",
        "designator": "U1",
        "x": 60,
        "y": 80,
        "rotation": 0
      },
      {
        "id": "d0a1b2c3-4d5e-4f60-8a9b-0c1d2e3f4a01",
        "device": "lab:adc-module",
        "designator": "U2",
        "x": 320,
        "y": 60,
        "rotation": 0
      },
      {
        "id": "d0a1b2c3-4d5e-4f60-8a9b-0c1d2e3f4a02",
        "device": "lab:dac-module",
        "designator": "U3",
        "x": 320,
        "y": 260,
        "rotation": 0
      },
      {
        "id": "d0a1b2c3-4d5e-4f60-8a9b-0c1d2e3f4a03",
        "device": "lab:pot-module",
        "designator": "RV1",
        "x": 60,
        "y": 260,
        "rotation": 0
      },
      {
        "id": "e0000001-2222-4333-8444-000000000001",
        "device": "builtin:text",
        "x": 60,
        "y": 20,
        "rotation": 0,
        "properties": {
          "text": "模拟电压：RV1.WIPER → U2.AIN0；U3.VOUT0 → U2.AIN1 环回；U1.GPIO → U2.CS"
        }
      },
      {
        "id": "e0000002-2222-4333-8444-000000000002",
        "device": "builtin:text",
        "x": 60,
        "y": 380,
        "rotation": 0,
        "properties": {
          "text": "RFC 0002：RV1/U3 用 pin.writeAnalog 写电压意图，U2 在 tick 里用 pin.sampleAnalog 读回解网电压"
        }
      }
    ],
    "wires": [],
    "junctions": []
  }
}
