---
name: low-power
description: Reduce firmware power draw with sleep modes, clock gating, and peripheral management
category: gamedev
---

# Low Power

Use when a battery-powered device must extend run time: cut active current, sleep aggressively, and wake only on events.

1. Measure baseline current first (bench supply or coulomb counter) so every change is verified against real numbers.
2. Restructure to event-driven: do work, then enter the deepest sleep mode that still allows the needed wake source.
3. Wake from interrupts/RTC/peripheral events rather than polling; remove busy-wait and fixed delay loops.
4. Gate clocks and power down unused peripherals, and configure idle GPIOs (pull or drive) to stop leakage current.
5. Lower the active clock to the slowest rate that meets the deadline; run fast-then-sleep ("race to idle") when bursty.
6. Re-measure after each change and check average current over a full duty cycle, not just the peak.

## Rules
- Floating input pins leak current — set every unused GPIO to a defined pull or output level before sleeping.
- Confirm your chosen sleep mode retains the RAM/registers and wake sources you actually need before relying on it.
- Disable or reconfigure debug/SWD, brown-out, and watchdog peripherals that quietly keep current high in sleep.
- Average current over the whole duty cycle drives battery life; a low sleep current is moot if wakeups are too frequent.
- Always re-measure on hardware; datasheet sleep figures assume an ideal configuration you probably have not matched.
