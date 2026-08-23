/** KST calendar-date handling. The free pull resets at 00:00 Asia/Seoul. */

/** Injectable clock so tests are time-independent. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** Current KST calendar date as YYYY-MM-DD (en-CA locale gives ISO format). */
export function kstDateString(clock: Clock = systemClock): string {
	return clock().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}
