# iOS parity battery, read from the unified log

Captured 2026-08-31T12:16Z on iPhone 17 Pro / iOS 26.5.
Every line below came from `log show --predicate 'subsystem == "dev.janela"'`,
not from a screenshot — that is what the os_log change bought.

```
PARITY sync answered at t+2ms while async pending
PARITY due-order: defer@1, s20@21, s50@53, s80@83
PARITY fs roundtrip exact=true len=12
PARITY missing -> error ok
PARITY DONE
PARITY async -> slept 300 at t+317ms
PARITY reject -> deliberate
```
