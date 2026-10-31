# RiderTap post-deploy smoke test

Run against the **draft** deploy URL first (deploy is created with
`draft: true`); promote only after every box passes. Then repeat steps
1–3 briefly on the production URL after promotion. Use the **demo school**
tenant for all of this — never a real school's code.

Two devices (or two independent browser sessions) required, mirroring the
proven local sim (~/workspace/ridertap/TWO_WALKER_SIM_TEST.md):

- [ ] 1. Open the live URL on session A. Enter the demo school join code.
        Board loads; school profile shows (no student data anywhere).
- [ ] 2. Session B: same URL, same code → same school, same empty board
        (cross-device shared state confirmed).
- [ ] 3. Two-walker run (spots/wave = 4 on the demo tenant): A on LEFT,
        B on RIGHT, interleaved 101/201 … 105/205 as fast as possible.
        Expected: Left W1 S1–4 = 101–104, W2 S1 = 105; Right identical
        pattern with 201–205. No lost/duplicated/misassigned entries.
- [ ] 4. B re-enters 101 → "Already Called" with lane/wave/spot of the
        original. A re-enters 201 → same. (Atomic duplicate guard, live.)
- [ ] 5. Loader: advance Left W1 cars to Loaded; Release LEFT W1 → succeeds
        while Right W1 is still incomplete; Right release stays blocked
        until its own count matches, then succeeds.
- [ ] 6. Office sets a HOLD on a right-lane number → red/blocked on Board
        and Loader on BOTH sessions within one poll cycle (~3s);
        Walker B entering that number shows the hold alert.
- [ ] 7. Latency sanity: entries from A appear on B within one poll cycle
        (~3s). Note the observed worst case here: ______ s.
- [ ] 8. Tenant isolation: open a second school code (provision a throwaway
        tenant) → its board is empty and none of the demo entries appear.
- [ ] 9. Offline: on A, enable the app's Simulate Offline, enter 2 numbers
        (queued banner counts them), disable → green "synced" confirmation,
        numbers on B in original order. Reload A mid-queue once: queue
        survives (localStorage outbox).
- [ ] 10. End Dismissal on the demo tenant → summary (cars/waves/no-shows)
        shows; board purges; the OTHER tenant's state untouched.
- [ ] 11. Proof Report surface (once the frozen build includes it): the
        report reads the demo tenant's day summaries — duration, cars,
        waves, holds, no-shows — and the semester trend includes today.

All pass → promote the draft (`netlify-digest-deploy.py --promote <id>`),
then re-run 1–3 on the production URL. Any failure → do NOT promote; the
draft URL is the debugging surface, and no deploy credit was spent on the
fix until the corrected bundle is uploaded as a new draft.
