{
  "version": 1,
  "sheet": {
    "symbols": [
      {
        "id": "a1000000-0000-4000-8000-000000000001",
        "device": "demo:potentiometer",
        "designator": "RV1",
        "x": 220,
        "y": 120,
        "rotation": 0
      },
      {
        "id": "a1000000-0000-4000-8000-000000000002",
        "device": "builtin:power",
        "net": "VDD",
        "x": 80,
        "y": 115,
        "rotation": 0
      },
      {
        "id": "a1000000-0000-4000-8000-000000000003",
        "device": "builtin:ground",
        "net": "GND",
        "x": 80,
        "y": 160,
        "rotation": 0
      },
      {
        "id": "a1000000-0000-4000-8000-000000000004",
        "device": "demo:ideal-led",
        "designator": "D1",
        "x": 500,
        "y": 120,
        "rotation": 0,
        "properties": { "brightnessSamples": 1 }
      },
      {
        "id": "a1000000-0000-4000-8000-000000000005",
        "device": "builtin:ground",
        "net": "GND",
        "x": 650,
        "y": 120,
        "rotation": 0
      },
      {
        "id": "a1000000-0000-4000-8000-000000000006",
        "device": "demo:teaching-mcu",
        "designator": "U1",
        "x": 220,
        "y": 260,
        "rotation": 0
      },
      {
        "id": "a1000000-0000-4000-8000-000000000007",
        "device": "demo:ideal-led",
        "designator": "D2",
        "x": 500,
        "y": 245,
        "rotation": 0,
        "properties": { "brightnessSamples": 64 }
      },
      {
        "id": "a1000000-0000-4000-8000-000000000008",
        "device": "builtin:ground",
        "net": "GND",
        "x": 650,
        "y": 245,
        "rotation": 0
      },
      {
        "id": "a1000000-0000-4000-8000-000000000009",
        "device": "builtin:power",
        "net": "VDD",
        "x": 360,
        "y": 355,
        "rotation": 0
      },
      {
        "id": "a1000000-0000-4000-8000-00000000000a",
        "device": "demo:ideal-led",
        "designator": "D3",
        "x": 500,
        "y": 355,
        "rotation": 0,
        "properties": { "brightnessSamples": 1 }
      },
      {
        "id": "a1000000-0000-4000-8000-00000000000b",
        "device": "builtin:ground",
        "net": "GND",
        "x": 650,
        "y": 355,
        "rotation": 0
      }
    ],
    "wires": [
      {
        "id": "a2000000-0000-4000-8000-000000000001",
        "points": [
          { "x": 80, "y": 115 },
          { "x": 145, "y": 115 }
        ]
      },
      {
        "id": "a2000000-0000-4000-8000-000000000002",
        "points": [
          { "x": 145, "y": 125 },
          { "x": 100, "y": 125 },
          { "x": 100, "y": 160 },
          { "x": 80, "y": 160 }
        ]
      },
      {
        "id": "a2000000-0000-4000-8000-000000000003",
        "points": [
          { "x": 295, "y": 120 },
          { "x": 420, "y": 120 }
        ]
      },
      {
        "id": "a2000000-0000-4000-8000-000000000004",
        "points": [
          { "x": 580, "y": 120 },
          { "x": 650, "y": 120 }
        ]
      },
      {
        "id": "a2000000-0000-4000-8000-000000000005",
        "points": [
          { "x": 280, "y": 245 },
          { "x": 420, "y": 245 }
        ]
      },
      {
        "id": "a2000000-0000-4000-8000-000000000006",
        "points": [
          { "x": 580, "y": 245 },
          { "x": 650, "y": 245 }
        ]
      },
      {
        "id": "a2000000-0000-4000-8000-000000000007",
        "points": [
          { "x": 360, "y": 355 },
          { "x": 420, "y": 355 }
        ]
      },
      {
        "id": "a2000000-0000-4000-8000-000000000008",
        "points": [
          { "x": 580, "y": 355 },
          { "x": 650, "y": 355 }
        ]
      }
    ],
    "junctions": []
  }
}
