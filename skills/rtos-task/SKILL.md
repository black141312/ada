---
name: rtos-task
description: Create an RTOS task with the right stack, priority, and inter-task communication
category: gamedev
---

# RTOS Task

Use when adding a task/thread under an RTOS (FreeRTOS, Zephyr, ThreadX) and wiring it into the scheduler safely.

1. Define the task function as an infinite loop that blocks on something (queue, semaphore, delay) — never a tight spin.
2. Size the stack from worst-case call depth plus ISR/printf usage; start generous, then measure the high-water mark.
3. Assign priority by deadline urgency, not importance; keep most tasks at the same level to avoid starvation.
4. Use queues or message buffers for data hand-off and semaphores/notifications for signaling between tasks/ISRs.
5. Block with `vTaskDelayUntil` (or equivalent) for periodic work so the period does not drift with execution time.
6. From ISRs use only the `FromISR` APIs and yield if a higher-priority task was woken.

## Rules
- Never busy-wait in a task; block on a primitive so lower-priority tasks and idle/sleep can run.
- Protect shared state with a mutex (with priority inheritance), not by disabling interrupts for long spans.
- Keep ISRs short: defer work to a task via a queue or task notification, call only `FromISR` variants.
- Validate stack high-water marks and enable stack-overflow checking during bring-up — overflow corrupts silently.
- Beware priority inversion and unbounded blocking; prefer mutexes with inheritance over plain binary semaphores for locking.
