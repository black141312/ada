---
name: firmware-driver
description: Write a bare-metal peripheral driver against a memory-mapped register interface
category: gamedev
---

# Firmware Driver

Reach for this when bringing up an MCU peripheral or external chip from the datasheet with no HAL to lean on.

1. Read the datasheet/reference manual: find the register map, base address, bit fields, and the reset/init sequence.
2. Define registers as `volatile` typed pointers or a packed struct at the base address; mirror field names from the manual.
3. Write a blocking init: enable the peripheral clock, configure mode/pins, set dividers, then enable the peripheral.
4. Implement read/write as small functions that poll status flags or use interrupts; never busy-spin without a timeout.
5. Add a timeout and error return to every wait loop so a missing/hung device cannot lock the firmware.
6. Bring up incrementally: verify clock and a known read-only ID register before attempting full transfers.

## Rules
- Mark every register access `volatile`; the compiler will otherwise cache or reorder hardware reads/writes.
- Use read-modify-write for shared registers; blind writes clobber neighboring control bits.
- Respect required ordering and delays in the init sequence — some bits must settle before the next write.
- Guard every hardware wait loop with a timeout and surface failures; silent infinite loops are unrecoverable in the field.
- Watch volatile aliasing and memory barriers around DMA buffers shared with the peripheral.
