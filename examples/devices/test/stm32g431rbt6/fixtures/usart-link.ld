ENTRY(reset)
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 0x20000
}
SECTIONS
{
  .text : {
    KEEP(*(.isr_vector))
    *(.text*)
    *(.rodata*)
  } > FLASH
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) }
}
