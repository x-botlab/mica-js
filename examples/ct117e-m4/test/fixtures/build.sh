#!/bin/sh
# Development-time fixture builder; runtime tests only read the .bin files.
set -eu
cd "$(dirname "$0")"

for name in led-latch led-lcd led-read buttons adc adc-idle; do
  arm-none-eabi-as -mcpu=cortex-m4 -mthumb "$name.S" -o "/tmp/$name.o"
  arm-none-eabi-ld -T board.ld -o "/tmp/$name.elf" "/tmp/$name.o"
  arm-none-eabi-objcopy -O binary "/tmp/$name.elf" "$name.bin"
done
