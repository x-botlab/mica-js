{
  "version": 1,
  "sheet": {
    "symbols": [
      {
        "id": "00000006-2dc0-44c6-8963-e4ea065d722b",
        "device": "stm32-package:stm32g431rbt6-lqfp64",
        "x": 480,
        "y": 200,
        "rotation": 0,
        "properties": {
          "label": "MCU",
          "firmware": {
            "src": "assets/firmware/m4-demo.bin",
            "mode": "file"
          }
        }
      },
      {
        "id": "00000008-9054-4323-8487-62af20580a94",
        "device": "at89-package:at89c52",
        "x": 760,
        "y": 380,
        "rotation": 0,
        "properties": {
          "speed": 12
        }
      },
      {
        "id": "00000005-c16f-4700-81a9-7ef80c62a850",
        "device": "lcd-package:ct117e-m4-tft-lcd-2-4",
        "x": 136,
        "y": 60,
        "rotation": 0,
        "properties": {
          "panel": {
            "src": "assets/panel.png",
            "mode": "file"
          },
          "orientation": "portrait"
        }
      },
      {
        "id": "00000007-88ff-48b9-8096-f1137382e67f",
        "device": "timer-package:ne555",
        "x": 300,
        "y": 380,
        "rotation": 0
      },
      {
        "id": "00000003-4d70-4c65-8b59-601eaeb86945",
        "device": "builtin:label",
        "x": 268,
        "y": 150,
        "rotation": 0,
        "net": "D2"
      },
      {
        "id": "00000004-9939-4156-8e78-135a99c479d8",
        "device": "builtin:power",
        "x": 480,
        "y": 120,
        "rotation": 0,
        "net": "3V3"
      },
      {
        "id": "00000001-5e00-46a2-88d7-e216a3f0f75a",
        "device": "builtin:ground",
        "x": 480,
        "y": 300,
        "rotation": 0,
        "net": "GND"
      }
    ],
    "wires": [
      {
        "id": "00000009-d219-4ea3-84bb-593c369c1900",
        "points": [
          {
            "x": 405,
            "y": 185
          },
          {
            "x": 250,
            "y": 185
          },
          {
            "x": 250,
            "y": 50
          },
          {
            "x": 66,
            "y": 50
          }
        ]
      },
      {
        "id": "0000000b-3b70-43f3-8425-482db6f77ef2",
        "points": [
          {
            "x": 250,
            "y": 150
          },
          {
            "x": 268,
            "y": 150
          }
        ]
      },
      {
        "id": "0000000d-84a6-479f-8077-5f49f0d1efba",
        "points": [
          {
            "x": 480,
            "y": 160
          },
          {
            "x": 480,
            "y": 120
          }
        ]
      },
      {
        "id": "0000000a-5403-4a30-88ca-17bc865bfbfa",
        "points": [
          {
            "x": 480,
            "y": 240
          },
          {
            "x": 480,
            "y": 300
          }
        ]
      },
      {
        "id": "0000000c-804d-489f-8062-db22ac5215dc",
        "points": [
          {
            "x": 370,
            "y": 380
          },
          {
            "x": 420,
            "y": 380
          },
          {
            "x": 420,
            "y": 470
          },
          {
            "x": 60,
            "y": 470
          },
          {
            "x": 60,
            "y": 60
          },
          {
            "x": 66,
            "y": 60
          }
        ]
      }
    ],
    "junctions": [
      {
        "id": "00000002-7f63-4f2a-870b-45319d0e7b45",
        "x": 250,
        "y": 150,
        "wires": [
          "00000009-d219-4ea3-84bb-593c369c1900",
          "0000000b-3b70-43f3-8425-482db6f77ef2"
        ]
      }
    ]
  }
}
