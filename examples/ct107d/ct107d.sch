{
  "version": 2,
  "dependencies": {
    "example:ct107d-board": {
      "version": "0.1.0",
      "integrity": "sha256:8411ac9f28d9d3b705944a60d0197b72054552ce6564de8fd608fd52f925c4e5"
    }
  },
  "instances": [
    {
      "id": "7d9e3a1c-5b2f-4c8d-9e01-2a3b4c5d6e7f",
      "device": "example:ct107d-board",
      "designator": "U1",
      "placement": {
        "x": 0,
        "y": 0,
        "rotation": 0
      },
      "properties": {
        "clockFrequency": 12000000,
        "firmware": {
          "mode": "package",
          "src": "assets/seg7-dynamic.hex"
        }
      }
    }
  ],
  "nodes": [],
  "wires": [],
  "labels": [],
  "references": [
    {
      "id": "8b3a2f10-6c4d-4e9a-b7f2-1d5c9e0a3b48",
      "target": {
        "kind": "pin",
        "instance": "7d9e3a1c-5b2f-4c8d-9e01-2a3b4c5d6e7f",
        "pin": "VCC"
      },
      "voltage": 5,
      "symbol": "power",
      "label": {
        "name": "VCC"
      }
    },
    {
      "id": "c4d5e6f7-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
      "target": {
        "kind": "pin",
        "instance": "7d9e3a1c-5b2f-4c8d-9e01-2a3b4c5d6e7f",
        "pin": "GND"
      },
      "voltage": 0,
      "symbol": "ground",
      "label": {
        "name": "GND"
      }
    }
  ],
  "display": {
    "body": true,
    "designators": false
  }
}
