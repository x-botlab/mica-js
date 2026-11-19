ENTRY(reset)

MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 128K
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

  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) }
}
