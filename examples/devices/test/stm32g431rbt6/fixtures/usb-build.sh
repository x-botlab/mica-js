#!/bin/sh
set -eu
cd "$(dirname "$0")"
arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -O2 -ffreestanding -fno-builtin \
  -nostdlib -nostartfiles -T usb-link.ld usb-firmware.c -o usb-firmware.elf
arm-none-eabi-objcopy -O binary usb-firmware.elf usb-firmware.bin
