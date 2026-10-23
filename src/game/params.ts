/** Tunable numbers of the board game, in one place. */

/** metres of a class-1.0 road one movement point buys in the truck */
export const TRUCK_M = 600;
/** metres one movement point buys in the boat */
export const BOAT_M = 420;
/** movement points spent lifting a family aboard */
export const PICKUP_MP = 1;
/** truck stalls when it ends the round in water deeper than this */
export const STALL_DEPTH = 0.5;
/** movement points lost the round after a stall */
export const STALL_MP = 3;
/** a shelter closes to new arrivals when water at its door is deeper than this (reopens below half) */
export const SHELTER_CLOSE_DEPTH = 0.4;
/** a family is stranded (cannot be rescued any more) at this much accumulated distress */
export const LOST_DISTRESS = 3;
/** distress added each round by the water at a family's home */
export function distressFromDepth(d: number): number {
  return d >= 1.5 ? 2 : d >= 0.8 ? 1.2 : d >= 0.4 ? 0.6 : d >= 0.15 ? 0.25 : 0;
}
/** calls waiting more than this many rounds slowly lose hope even above the water */
export const AGE_DISTRESS = 0.2;
