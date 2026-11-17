#!/bin/sh
set -eu
cd "$(dirname "$0")"
arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -O2 -ffreestanding -fno-builtin \
  -nostdlib -nostartfiles -T usb-link.ld usb-ep0-irq-firmware.c -o usb-ep0-irq-firmware.elf
arm-none-eabi-objcopy -O binary usb-ep0-irq-firmware.elf usb-ep0-irq-firmware.bin
