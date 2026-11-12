/*
 * STM32G431CB memory layout for the bare-metal Thumb fixtures.
 *
 * Flash 128 KiB at 0x08000000 and SRAM 32 KiB at 0x20000000. The image is a
 * pure flash image: code, vector table and literal pools only. Fixtures use
 * absolute SRAM addresses from code, so no .data/.bss is linked and the ELF
 * binary maps 1:1 onto the flash image a CPU model loads.
 */
ENTRY(reset_handler)

MEMORY
{
    FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 128K
    SRAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 32K
}

SECTIONS
{
    .vectors 0x08000000 :
    {
        KEEP(*(.vectors))
    } > FLASH

    .text 0x08000100 :
    {
        *(.text*)
        *(.rodata*)
    } > FLASH

    /DISCARD/ :
    {
        *(.ARM.exidx*)
        *(.ARM.extab*)
        *(.ARM.attributes)
        *(.comment)
        *(.note*)
    }
}

ASSERT(SIZEOF(.text) <= LENGTH(FLASH), "fixture image exceeds 128 KiB of flash")
