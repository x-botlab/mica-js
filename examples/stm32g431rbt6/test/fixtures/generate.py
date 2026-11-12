"""用 Keystone 生成 STM32G431RBT6 测试固件（开发期工具，不参与运行期）。

固件是裸二进制：前两个字是初始 SP 与复位入口，其余是指令与常量。`vectors` 的键是
异常号（0 是初始 SP，1 是复位），不是字节偏移。
"""

from keystone import KS_ARCH_ARM, KS_MODE_THUMB, Ks
from pathlib import Path

OUT = Path(__file__).parent
BASE = 0x08000000
CODE_BASE = BASE + 8
SP = 0x20005800


def assemble(source: str, base: int = CODE_BASE) -> bytes:
    ks = Ks(KS_ARCH_ARM, KS_MODE_THUMB)
    encoding, _ = ks.asm(source, base)
    return bytes(encoding)


def image(code: bytes, vectors: dict[int, int] | None = None, code_base: int = CODE_BASE) -> bytes:
    table = {0: SP, 1: code_base | 1}
    if vectors:
        table.update(vectors)
    code_offset = code_base - BASE
    size = max([code_offset + len(code)] + [(index + 1) * 4 for index in table])
    data = bytearray(size)
    for index, value in table.items():
        data[index * 4 : index * 4 + 4] = value.to_bytes(4, "little")
    data[code_offset : code_offset + len(code)] = code
    return bytes(data)


def write(
    name: str,
    source: str,
    vectors: dict[int, int] | None = None,
    code_base: int = CODE_BASE,
    code: bytes | None = None,
) -> None:
    if code is None:
        code = assemble(source, code_base)
    (OUT / f"{name}.asm").write_text(source, encoding="utf-8")
    data = image(code, vectors, code_base)
    (OUT / f"{name}.bin").write_bytes(data)
    print(f"{name}: {len(code)} bytes of code, {len(data)} bytes image")


write(
    "gpio-blink",
    """
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r0, #0x0000
    movt r0, #0x4800
    movw r1, #0x0400
    str r1, [r0, #0]
loop:
    movs r1, #0x20
    str r1, [r0, #0x14]
    bl delay
    movs r1, #0
    str r1, [r0, #0x14]
    bl delay
    b loop
delay:
    movw r2, #0x00ff
dloop:
    subs r2, r2, #1
    bne dloop
    bx lr
""",
)

write(
    "gpio-input",
    """
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #4
    str r1, [r0, #0]
    movs r1, #2
    str r1, [r0, #0x0c]
loop:
    ldr r1, [r0, #0x10]
    ands r1, r1, #1
    lsls r1, r1, #1
    str r1, [r0, #0x14]
    b loop
""",
)

write(
    "uart2-tx",
    """
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r1, #0x0002
    movt r1, #0x0002
    str r1, [r0, #0x58]
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #0x20
    str r1, [r0, #0]
    movw r1, #0x0700
    str r1, [r0, #0x20]
    movw r0, #0x4400
    movt r0, #0x4000
    movs r1, #0x8b
    str r1, [r0, #0x0c]
    movs r1, #9
    str r1, [r0, #0]
    movs r1, #0x4f
    str r1, [r0, #0x28]
    movs r1, #0x4b
    str r1, [r0, #0x28]
loop:
    b loop
""",
)

write(
    "arith",
    """
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r0, #0x0000
    movt r0, #0x4800
    movw r1, #0x5555
    str r1, [r0, #0]
    movw r1, #0x1234
    movw r2, #0x00f0
    ands r3, r1, r2
    orr.w r3, r3, #0xc0
    ubfx r4, r3, #4, #4
    lsls r4, r4, #4
    eors r3, r4
    cmp r3, #0
    bne fail
    movs r3, #0x30
    str r3, [r0, #0x14]
    b done
fail:
    movs r3, #0xff
    str r3, [r0, #0x14]
done:
    b done
""",
)

# SysTick 每 1 ms 触发一次，处理程序在 0x08000100 翻转 PA5。复位入口放在向量表之后。
systick_source = """
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r0, #0x0000
    movt r0, #0x4800
    movw r1, #0x0400
    str r1, [r0, #0]
    movw r0, #0xe010
    movt r0, #0xe000
    movw r1, #0x3e7f
    movt r1, #0x0000
    str r1, [r0, #4]
    movs r1, #0
    str r1, [r0, #8]
    movs r1, #7
    str r1, [r0, #0]
loop:
    b loop
"""
handler = assemble(
    """
    movw r0, #0x0000
    movt r0, #0x4800
    ldr r1, [r0, #0x14]
    movs r2, #0x20
    eors r1, r2
    str r1, [r0, #0x14]
    bx lr
""",
    0x08000100,
)
systick_code = assemble(systick_source, 0x08000040)
systick_data = bytearray(image(systick_code, {15: 0x08000100}, 0x08000040))
if len(systick_data) < 0x100:
    systick_data.extend(bytes(0x100 - len(systick_data)))
systick_data[0x100 : 0x100 + len(handler)] = handler
(OUT / "systick.asm").write_text(systick_source, encoding="utf-8")
(OUT / "systick.bin").write_bytes(bytes(systick_data))
print(f"systick: {len(systick_code)} bytes of code, {len(systick_data)} bytes image, handler {len(handler)}")
