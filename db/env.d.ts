declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** Server-only repeatable coupon: 100 of each ticket type. Unset or blank disables the private coupon route. */
    PRIVATE_CARD_COUPON?: string;
    /** Server-only repeatable coupon: 200 copies of every catalog card. */
    PRIVATE_EACH_CARD_COUPON?: string;
  }
}
