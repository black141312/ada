---
name: i2c-spi
description: Configure I2C or SPI peripheral communication and debug bus-level issues
category: gamedev
---

# I2C / SPI

Reach for this when talking to a sensor, EEPROM, or display over I2C or SPI and the link is not working yet.

1. From the datasheet get the device address (I2C) or CS pin + SPI mode (CPOL/CPHA) and max clock rate.
2. Configure pins: I2C needs open-drain SDA/SCL with pull-ups; SPI needs MOSI/MISO/SCK plus a GPIO chip-select.
3. Set the bus clock below the device max, then do a probe: I2C address ACK scan, or SPI read of a known ID register.
4. Implement a transfer: I2C start→addr+R/W→data→stop; SPI assert CS→full-duplex byte exchange→deassert CS.
5. Add per-transfer timeouts and check ACK/error flags; return an error instead of hanging on a missing device.
6. Verify with a logic analyzer if the first transfer fails — confirm clock, framing, and ACK on the wire.

## Rules
- I2C requires pull-up resistors on SDA and SCL; floating lines look like a dead bus.
- Match SPI mode (CPOL/CPHA) exactly to the device; a wrong mode gives garbage with no error flag.
- Toggle chip-select per transaction and honor setup/hold timing; sharing CS or wrong polarity corrupts reads.
- Respect register auto-increment and burst-read rules; many devices need a specific address-then-read sequence.
- On a stuck I2C bus (SDA held low), clock out up to 9 pulses or power-cycle the device to recover.
