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
        "id": "d0a1b2c3-4d5e-4f60-8a9b-0c1d2e3f4a06",
        "device": "lab:shift-register",
        "designator": "U2",
        "x": 280,
        "y": 80,
        "rotation": 0
      },
      {
        "id": "d0a1b2c3-4d5e-4f60-8a9b-0c1d2e3f4a05",
        "device": "lab:led-matrix",
        "designator": "DS1",
        "x": 520,
        "y": 80,
        "rotation": 0
      },
      {
        "id": "e0000021-2222-4333-8444-000000000021",
        "device": "builtin:text",
        "x": 60,
        "y": 20,
        "rotation": 0,
        "properties": {
          "text": "并行总线（RFC 0004）：U2.Q0–Q7 → DS1.D0–D7；U1.GPIO → DS1.ROW0 选通第 0 行"
        }
      },
      {
        "id": "e0000022-2222-4333-8444-000000000022",
        "device": "builtin:text",
        "x": 60,
        "y": 340,
        "rotation": 0,
        "properties": {
          "text": "U2：pinGroup(Q0..Q7).writeDigital(byte) 一次写八根线，再从解网电平 readDigital 回读。DS1：用两个 pinGroup 批量读取 ROW/DATA。"
        }
      }
    ],
    "wires": [],
    "junctions": []
  }
}
