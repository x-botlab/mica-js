"""用 GNU arm-none-eabi-as 生成时钟/PWR 测试固件（开发期工具，不参与运行期）。

现有 fixtures/generate.py 依赖 Keystone；本机没有该模块，因此时钟相关夹具改用
`arm-none-eabi-as` + `objcopy`。生成的 `.bin` 前两个字仍是初始 SP 与复位入口，
代码从 0x08000008 开始。
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

OUT = Path(__file__).parent / "fixtures"
BASE = 0x08000000
CODE_BASE = BASE + 8
SP = 0x20005800

SOURCES: dict[str, str] = {
    "rcc-pll": """
    movw r0, #0x1000
    movt r0, #0x4002          @ RCC
    @ PLL: HSI, M=2, N=20, PLLPEN, PLLPDIV=2, PLLREN -> VCO 160 MHz, R/P 80 MHz
    movw r1, #0x1412
    movt r1, #0x1101
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ PLLON
    @ SW=PLL, HPRE=/1, PPRE1=/2, PPRE2=/4
    movw r1, #0x2c03
    str r1, [r0, #0x08]
    movs r1, #1
    str r1, [r0, #0x90]       @ BDCR.LSEON：USART3 选择 LSE
    @ USART1=SYSCLK, USART2=HSI, USART3=LSE,
    @ I2C1=SYSCLK, I2C2=HSI, I2C3=reserved, ADC12=PLLP
    movw r1, #0x9039
    movt r1, #0x1003
    str r1, [r0, #0x88]
done:
    b done
""",
    "rcc-invalid": """
    movw r0, #0x1000
    movt r0, #0x4002
    @ PLLN=4 (< 8), M=2 -> PLL must not lock
    movw r1, #0x0412
    movt r1, #0x0100
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]
    movs r1, #3
    str r1, [r0, #0x08]       @ request PLL
    ldr r2, [r0, #0x00]
    ldr r3, [r0, #0x08]
    movw r4, #0x0000
    movt r4, #0x2000
    str r2, [r4, #0x00]
    str r3, [r4, #0x04]
done:
    b done
""",
    "rcc-switch": """
    movw r0, #0x1000
    movt r0, #0x4002
    @ HSE on, but no crystal is populated in the model
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0001
    orrs r1, r1, r2
    str r1, [r0, #0x00]
    movs r1, #2
    str r1, [r0, #0x08]       @ request HSE
    @ request PLL while PLL is still off
    movs r1, #3
    str r1, [r0, #0x08]
    ldr r2, [r0, #0x08]
    ldr r3, [r0, #0x00]
    movw r5, #0x0000
    movt r5, #0x2000
    str r2, [r5, #0x00]
    str r3, [r5, #0x04]
done:
    b done
""",
    "rcc-hse": """
    movw r0, #0x1000
    movt r0, #0x4002
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0001
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ HSEON
    @ PLL: HSE, M=3, N=20, PLLREN -> 24/3*20/2 = 80 MHz
    movw r1, #0x1423
    movt r1, #0x0100
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ PLLON
    movs r1, #3
    str r1, [r0, #0x08]       @ SW=PLL
    ldr r2, [r0, #0x00]
    ldr r3, [r0, #0x08]
    movw r4, #0x0000
    movt r4, #0x2000
    str r2, [r4, #0x00]
    str r3, [r4, #0x04]
done:
    b done
""",
    "rcc-reset": """
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x4c]       @ AHB2ENR.GPIOAEN
    movw r6, #0x0000
    movt r6, #0x4800          @ GPIOA
    movw r1, #0x0400
    str r1, [r6, #0x00]       @ PA5 output
    movs r1, #0x20
    str r1, [r6, #0x14]       @ PA5 high
    movw r1, #0x0000
    movt r1, #0x0002
    str r1, [r0, #0x58]       @ APB1ENR1.USART2EN
    movw r7, #0x4400
    movt r7, #0x4000          @ USART2
    movs r1, #9
    str r1, [r7, #0x00]       @ UE|TE
    movw r1, #0x022b
    str r1, [r7, #0x0c]       @ BRR
    movs r1, #0x41
    str r1, [r7, #0x28]       @ start 'A'
    movw r8, #0x00ff
wait:
    subs r8, r8, #1
    bne wait
    movw r1, #0x0000
    movt r1, #0x0002
    str r1, [r0, #0x38]       @ APB1RSTR1.USART2RST
    movs r1, #1
    str r1, [r0, #0x2c]       @ AHB2RSTR.GPIOARST
    ldr r2, [r7, #0x00]
    ldr r3, [r6, #0x00]
    movw r4, #0x0000
    movt r4, #0x2000
    str r2, [r4, #0x00]
    str r3, [r4, #0x04]
done:
    b done
""",
    "pwr-vos": """
    movw r0, #0x1000
    movt r0, #0x4002
    movw r1, #0x0000
    movt r1, #0x1000
    str r1, [r0, #0x58]       @ APB1ENR1.PWREN
    movw r6, #0x7000
    movt r6, #0x4000          @ PWR
    movw r1, #0x0401
    str r1, [r6, #0x00]       @ VOS=Range2, LPMS=Stop1
    ldr r2, [r6, #0x14]       @ SR2
    ldr r3, [r6, #0x00]       @ CR1
    movs r1, #0x1f
    str r1, [r6, #0x18]       @ SCR W1C bits
    ldr r4, [r6, #0x18]
    movw r5, #0x0000
    movt r5, #0x2000
    str r2, [r5, #0x00]
    str r3, [r5, #0x04]
    str r4, [r5, #0x08]
done:
    b done
""",
    "clock-usart": """
    movw r0, #0x1000
    movt r0, #0x4002          @ RCC
    movs r1, #1
    str r1, [r0, #0x4c]       @ GPIOA clock
    movw r6, #0x0000
    movt r6, #0x4800          @ GPIOA
    movs r1, #0x20
    str r1, [r6, #0x00]       @ PA2 alternate function
    movw r1, #0x0700
    str r1, [r6, #0x20]       @ AF7 on PA2
    movw r1, #0x0000
    movt r1, #0x0002
    str r1, [r0, #0x58]       @ USART2 clock
    movw r7, #0x4400
    movt r7, #0x4000          @ USART2
    movw r1, #0x022b
    str r1, [r7, #0x0c]       @ BRR = 555
    movs r1, #9
    str r1, [r7, #0x00]       @ UE|TE
    movs r5, #0x40            @ ISR.TC
    movs r1, #0xff
    str r1, [r7, #0x28]       @ 0xFF at initial 16 MHz: start 位是整字节唯一的低脉冲
    bl wait_tc
    @ PLL 80 MHz from HSI
    movw r1, #0x1412
    movt r1, #0x0100
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]
    movs r1, #3
    str r1, [r0, #0x08]       @ SW=PLL, APB1/APB2 = /1
    movs r1, #0xff
    str r1, [r7, #0x28]       @ 0xFF at 80 MHz
    bl wait_tc
    movs r1, #8
    str r1, [r0, #0x88]       @ USART2SEL=HSI16
    movs r1, #0xff
    str r1, [r7, #0x28]       @ 0xFF at 16 MHz mux
    bl wait_tc
    movs r1, #0
    str r1, [r0, #0x88]       @ USART2SEL=PCLK1
    movs r1, #0xff
    str r1, [r7, #0x28]       @ 0xFF at 80 MHz
    bl wait_tc
done:
    b done
wait_tc:
    ldr r1, [r7, #0x1c]
    ands r1, r1, r5
    cmp r1, #0
    beq wait_tc
    bx lr
""",
    "clock-switch-order": """
    movw r0, #0x1000
    movt r0, #0x4002          @ RCC
    movs r1, #1
    str r1, [r0, #0x4c]       @ GPIOA clock
    movw r6, #0x0000
    movt r6, #0x4800          @ GPIOA
    movs r1, #0x20
    str r1, [r6, #0x00]       @ PA2 alternate function
    movw r1, #0x0700
    str r1, [r6, #0x20]       @ AF7 on PA2
    movw r1, #0x0000
    movt r1, #0x0002
    str r1, [r0, #0x58]       @ USART2 clock
    movw r7, #0x4400
    movt r7, #0x4000          @ USART2
    movw r1, #0x022b
    str r1, [r7, #0x0c]       @ BRR = 34.6875
    movs r1, #9
    str r1, [r7, #0x00]       @ UE|TE
    movs r5, #0x40            @ ISR.TC
    movs r1, #0xff
    str r1, [r7, #0x28]       @ byte at 16 MHz
    bl wait_tc
    @ PLL 80 MHz, APB1=/2 -> PCLK1 40 MHz, APB2=/4 -> PCLK2 20 MHz
    movw r1, #0x1412
    movt r1, #0x0100
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ PLLON
    movw r1, #0x2c03
    str r1, [r0, #0x08]       @ SW=PLL, PPRE1=/2, PPRE2=/4
    movs r1, #0xff
    str r1, [r7, #0x28]       @ byte at PCLK1 40 MHz
    bl wait_tc
    movs r1, #0x5a
    movw r2, #0x0400
    movt r2, #0x2000
    str r1, [r2]              @ marker at 0x20000400
done:
    b done
wait_tc:
    ldr r1, [r7, #0x1c]
    ands r1, r1, r5
    cmp r1, #0
    beq wait_tc
    bx lr
""",
}


def assemble(source: str) -> bytes:
    text = ".syntax unified\n.thumb\n.text\nstart:\n" + source + "\n.pool\n"
    with tempfile.TemporaryDirectory() as directory:
        asm = Path(directory) / "fixture.s"
        obj = Path(directory) / "fixture.o"
        raw = Path(directory) / "fixture.bin"
        asm.write_text(text, encoding="utf-8")
        subprocess.run(
            ["arm-none-eabi-as", "-mcpu=cortex-m4", "-mthumb", "-o", str(obj), str(asm)],
            check=True,
        )
        subprocess.run(["arm-none-eabi-objcopy", "-O", "binary", str(obj), str(raw)], check=True)
        return raw.read_bytes()


def write(name: str, source: str) -> None:
    code = assemble(source)
    data = bytearray(max(8 + len(code), 8))
    data[0:4] = SP.to_bytes(4, "little")
    data[4:8] = (CODE_BASE | 1).to_bytes(4, "little")
    data[8 : 8 + len(code)] = code
    (OUT / f"{name}.asm").write_text(
        ".syntax unified\n.thumb\n.text\nstart:\n" + source + "\n.pool\n", encoding="utf-8"
    )
    (OUT / f"{name}.bin").write_bytes(bytes(data))
    print(f"{name}: {len(code)} bytes of code, {len(data)} bytes image")


if __name__ == "__main__":
    for fixture, source in SOURCES.items():
        write(fixture, source)
