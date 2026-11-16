# Prestige solar + BESS + EV proposal calculator

Use this for every Prestige Renewable Solutions commercial proposal: reviewing a client's electricity bills, choosing a system size, and working out price, incentives, payment options, savings and payback.

The full formulas, eligibility rules and lessons learned are in references/methodology.md. Read it before the first calculation in a conversation.

scripts/calc.py runs the whole workout from one JSON file. examples/ holds two worked sites (Jetty Motel, Nov 2026) whose outputs match the sent proposals. scripts/selftest.py checks the formulas against confirmed past figures. Run it once after any edit to the script.

## Working style

- Show the full financial workout in chat first, as tables. Do not build a Word or PDF document until asked.
- Confirm figures before writing any file. Never update a sent document speculatively.
- Flag open items plainly: missing bills, unknown existing solar, unconfirmed prices, odd readings.
- Use the supply (metered) address from the bill, never the postal address. Ignore gas bills.

## Workflow

1. **Review the bills.** Extract for each billing period:
   - days, and kWh by peak / shoulder / off-peak band
   - solar export kWh and the feed-in credit
   - total charges incl. GST
   - rates: each band, supply per day, feed-in tariff, and any demand charge
2. **Annualise by day-weighting.** Show usage per day and per year, cost per year, blended c/kWh, the band split, and export per day. Watch for:
   - tariff changes mid-bill (each period uses its own rates)
   - one-off credits (exclude them from the run-rate)
   - winter-only data (say the result is conservative and ask for a summer bill)
   - export that is inconsistent between periods (possible metering issue)
   - Use actual usage charges as the cost basis, not payment-plan instalments.
3. **Size the system** against load and against past Prestige proposals:
   - ~50–80 MWh/yr sites: a 100 kWh WHES battery (BESS4) + 25–40 kW new solar.
   - ~85 MWh/yr+ sites, or sites with large solar export or EV revenue: a 261 kWh StarCharge eBOX (BESS5) + ≥ 60 kW new solar.
   - Battery size rule: usable battery capacity beyond the evening + overnight load only shifts cheap off-peak energy. That is the usual sign of oversizing.
4. **Run the calculator.** Copy an example JSON, change the site, tariff, system and prices, then run `python3 scripts/calc.py site.json`.
5. **Present the result** in this order: price table → incentives → net after incentives → Option A / Option B → savings breakdown → payback. Close with the open items.

## Current pricing conventions (Nov 2026)

- GST: all totals shown incl. GST, never "+ GST". Header tiles show incl. GST with the ex-GST figure below.
- Finance (default, `finance_mode: separate_on_net`):
  - System prices are shown at base price.
  - After incentives, the 24-month plan adds a separate finance line of 10% of the net price.
  - Paying outright carries no finance cost and no discount.
  - The older alternative is `finance_mode: uplift`: 10% added to the battery and solar base prices, plus 10% off for outright payment. Use it only if asked.
- Option A: 20% upfront, then 24 equal monthly instalments (rounded down to the cent; the final instalment absorbs the remainder).
- Option B: milestones of 20% at signing, 70% at installation, and 10% at commissioning.
- Payback: total payable ÷ annual benefit incl. GST, shown as Option A / Option B.

### Standard prices (ex-GST, confirm per job)

| Item | Price ex-GST |
|---|---|
| 100 kWh WHES PC-mini (50 kW) + ECC | $39,500 |
| 261 kWh StarCharge eBOX + ECC | $86,500 |
| 25 kW solar | $19,500 |
| 40 kW solar | $29,600 |
| 60.8 kW solar | $44,850 |
| 66 kW solar | $54,850 |
| 22 kW AC EV charger | $1,850–$2,150 each (Jetty used $2,150) |

## Incentives: quick rules

The full detail is in references/methodology.md.

- Usable capacity = 90% of nominal. Existing solar never counts.
- Eligibility: new solar must be ≥ ¼ of usable capacity, or there are zero PRCs.
- Timing: install on or after 1 Sep 2026, with the battery within 90 days of the new solar.
- BESS4 (20–200 kWh usable): tiered DSC, which already reduces PRCs for batteries that also take federal battery STCs. Claim both. Do not deduct STCs from PRCs again.
- BESS5 (> 200 kWh usable): BC × 0.1 × 900 × NLF. No battery STCs.
- Network loss factor (NLF): Ausgrid 1.04, Endeavour 1.05, Essential 1.05.
- Certificate prices: PRCs $2.60, STCs $38.
- Solar STCs = FLOOR(kW × zone × 5). NSW Zone 3 = 1.382.

## Savings model: what the script assumes

These are the defaults; override any of them in params.

- Solar yield: seasonal NSW coastal profile (~1,376 kWh/kWp/yr).
- Solar-window load: 30% of grid import falls in the solar window. Raise this for daytime-heavy sites such as offices, retail or supermarkets.
- Daytime solar value: valued at the rate the daytime grid energy is billed at.
- Battery charging and discharge:
  - The battery charges from surplus solar.
  - It discharges peak first, then shoulder, then off-peak, capped at the actual evening and overnight load.
  - 90% round-trip efficiency.
- Peak top-up: spare battery capacity is topped up from off-peak grid power, only for energy that would otherwise be billed at the peak rate.
- Export and pricing: remaining surplus exports at the feed-in tariff. No tariff escalation.
- EV revenue = chargers × 22 kW × 4 h × 5 days × 52 weeks × $0.15/kWh net margin. This is $6,864 ex-GST for 2 chargers, $7,550 incl. GST. Always label it an estimate that depends on use.
- Demand-tariff sites (e.g. EA302): add demand-charge shaving separately (see methodology). The blended rate misleads at these sites, so use the avoided marginal rate.
