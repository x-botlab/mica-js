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
        "id": "d0a1b2c3-4d5e-4f60-8a9b-0c1d2e3f4a04",
        "device": "lab:i2c-eeprom",
        "designator": "U2",
        "x": 340,
        "y": 100,
        "rotation": 0
      },
      {
        "id": "e0000011-2222-4333-8444-000000000011",
        "device": "builtin:text",
        "x": 60,
        "y": 20,
        "rotation": 0,
        "properties": {
          "text": "I²C EEPROM 0x50：SCL / SDA 均为开漏（open-drain + pull('up')），各配 4.7 kΩ 上拉到 3V3"
        }
      },
      {
        "id": "e0000012-2222-4333-8444-000000000012",
        "device": "builtin:text",
        "x": 60,
        "y": 300,
        "rotation": 0,
        "properties": {
          "text": "4.7 kΩ 上拉：SCL → 3V3，SDA → 3V3。器件只会拉低或释放，弱上拉把空闲总线拉高。"
        }
      },
      {
        "id": "e0000013-2222-4333-8444-000000000013",
        "device": "builtin:text",
        "x": 60,
        "y": 360,
        "rotation": 0,
        "properties": {
          "text": "U1.GPIO → U2.SDA：SDA 是唯一成网的引脚；SCL 只有 U2 一个引脚，不参与解算。"
        }
      }
    ],
    "wires": [],
    "junctions": []
  }
}
