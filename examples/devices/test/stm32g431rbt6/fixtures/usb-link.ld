ENTRY(reset)

MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 0x20000
  SRAM (rwx) : ORIGIN = 0x20000000, LENGTH = 0x5800
}

SECTIONS
{
  .isr_vector 0x08000000 :
  {
    KEEP(*(.isr_vector))
  } > FLASH

  .text :
  {
    *(.text*)
    *(.rodata*)
  } > FLASH

  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) *(.data*) *(.bss*) }
}
