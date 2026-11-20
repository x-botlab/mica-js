#!/bin/sh
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -f "$tmp/board-io.elf" "$tmp/board-io.hex"; rmdir "$tmp"' EXIT
arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -Os -ffreestanding -nostdlib \
  -Wl,--build-id=none,-Ttext=0x08000008,--section-start=.vectors=0x08000000,-e,reset \
  board-io.c -o "$tmp/board-io.elf"
arm-none-eabi-objcopy -O ihex -j .vectors -j .text "$tmp/board-io.elf" "$tmp/board-io.hex"
tr -d '\r' < "$tmp/board-io.hex" > board-io.hex
