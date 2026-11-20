#!/bin/sh
set -eu
cd "$(dirname "$0")"
arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -O0 -ffreestanding -fno-builtin \
  -nostdlib -nostartfiles -T usb-link.ld usb-pma-multi-strh.c -o usb-pma-multi-strh.elf
arm-none-eabi-objcopy -O binary usb-pma-multi-strh.elf usb-pma-multi-strh.bin
