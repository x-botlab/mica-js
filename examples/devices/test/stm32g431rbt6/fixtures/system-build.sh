#!/bin/sh
# 系统外设真实固件：CRC/RNG/RTC/IWDG/DMA。运行期测试只读 .bin。
set -eu
cd "$(dirname "$0")"
arm-none-eabi-as -mcpu=cortex-m4 -mthumb system-mcu.S -o /tmp/system-mcu.o
arm-none-eabi-ld -T usart-link.ld -o /tmp/system-mcu.elf /tmp/system-mcu.o
arm-none-eabi-objcopy -O binary /tmp/system-mcu.elf system-mcu.bin
arm-none-eabi-as -mcpu=cortex-m4 -mthumb --defsym NO_RNG=1 system-mcu.S -o /tmp/system-mcu-no-rng.o
arm-none-eabi-ld -T usart-link.ld -o /tmp/system-mcu-no-rng.elf /tmp/system-mcu-no-rng.o
arm-none-eabi-objcopy -O binary /tmp/system-mcu-no-rng.elf system-mcu-no-rng.bin
arm-none-eabi-as -mcpu=cortex-m4 -mthumb iwdg-reset.S -o /tmp/iwdg-reset.o
arm-none-eabi-ld -T usart-link.ld -o /tmp/iwdg-reset.elf /tmp/iwdg-reset.o
arm-none-eabi-objcopy -O binary /tmp/iwdg-reset.elf iwdg-reset.bin
arm-none-eabi-as -mcpu=cortex-m4 -mthumb wwdg-reset.S -o /tmp/wwdg-reset.o
arm-none-eabi-ld -T usart-link.ld -o /tmp/wwdg-reset.elf /tmp/wwdg-reset.o
arm-none-eabi-objcopy -O binary /tmp/wwdg-reset.elf wwdg-reset.bin
arm-none-eabi-as -mcpu=cortex-m4 -mthumb spi-dma-ch2.S -o /tmp/spi-dma-ch2.o
arm-none-eabi-ld -T usart-link.ld -o /tmp/spi-dma-ch2.elf /tmp/spi-dma-ch2.o
arm-none-eabi-objcopy -O binary /tmp/spi-dma-ch2.elf spi-dma-ch2.bin
