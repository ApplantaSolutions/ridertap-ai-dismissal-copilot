# School provisioning (execution-step procedure)

Provisioning is deliberately NOT a client action (the artifact's
`seedDemo`/`resetDemo` are not ported as public actions — in production they
would let anyone wipe a live school). Each school is created once, by us:

1. Generate the tenant id and join code:
   - `id` = `sch_` + 16 random hex chars
   - `join_code` = 8 chars, unambiguous alphabet (no 0/O/1/I), e.g. `RT-XXXXXX`
2. Insert one row into `schools` (Turso console SQL editor, or a one-off
   script using TURSO_DATABASE_URL/TURSO_AUTH_TOKEN from the secure store):
   profile fields from the school's Setup (name, district, county, state,
   school type, dismissal times, spots per wave, lane mode/labels) — or
   leave defaults and let the school complete Setup in the app with its code.
3. Hand the school ONE thing: the live URL + their join code. First device
   entry stores the code in localStorage (`ridertap-school-code-v1`); every
   staff phone at that school uses the same code.
4. Demo school: provision one extra tenant (the existing fictional
   "Auburn Elementary School" profile) with a code kept by Applanta, so the
   walkthrough/sales flow always has a safe sandbox that is NOT a real
   school's data.

Resetting a school mid-pilot (worst case): delete that school's rows from
car_entries/waves/holds for the school_id (same purge shape as
endDismissal) — never another school's, never the day_summaries history.
