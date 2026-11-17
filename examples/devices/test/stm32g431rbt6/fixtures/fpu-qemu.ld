ENTRY(reset)
SECTIONS {
 . = 0x00000000;
 .text : { *(.isr_vector) *(.text*) }
 .rodata : { *(.rodata*) }
 .data : { *(.data*) }
 .bss : { *(.bss*) *(COMMON) }
}
