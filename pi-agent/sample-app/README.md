# Sample app for the Pi agent example

A small, deliberately buggy support backend. Four of the five tickets in [`../tickets.json`](../tickets.json) come from a bug in this code. The fifth (TCK-1003, "Why is my account past due?") is a customer question that needs no code change.

| Ticket | Bug |
|---|---|
| TCK-1001 Charged twice for my order | `src/billing.js` charges again when checkout retries |
| TCK-1002 Can't sign in after password reset | `src/auth.js` creates sessions with the wrong version |
| TCK-1004 API returning 500 errors | `src/reports.js` crashes when there are no rows yet |
| TCK-1005 Order never arrived | `src/shipping.js` builds the tracking link from the order ID |

`test/app.test.js` fails until the bugs are fixed. Run it with Node.js 22+ from this folder:

```bash
node --test
```

To try a patch from the `runPi` task, save it as `fix.patch` and apply it from the repository root:

```bash
git apply fix.patch
```
